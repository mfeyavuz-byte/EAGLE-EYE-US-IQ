import { test } from "node:test";
import assert from "node:assert/strict";
import { dayFeatures, setupsAt, outcomeR, breadthSeries } from "../bot/setups.mjs";
import { buildAllow, allowedFor, partOf } from "../bot/setuplive.mjs";

const B = (c, i, o = c, v = 1000) => ({ ts: i * 3e5, open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c, volume: v });

test("FLUSH: açılış düşüşü (−%0.5) sindirilip açılış geri alınınca CALL (10:00–11:30)", () => {
  const cl = [99.9, 99.7, 99.5, 99.55, 99.6, 99.7, 99.8, 99.85, 99.9, 99.95, 100.05];
  const bars = cl.map((c, i) => B(c, i, i ? cl[i - 1] : 100));
  const f = dayFeatures(bars), i = bars.length - 1;
  const s = setupsAt(bars, f, i, 570 + 5 * (i + 1) + 30, null);   // 10:30 civarı
  assert.ok(s.some(x => x.name === "FLUSH" && x.dir === "C" && x.stop < bars[i].close));
});

test("PULLBACK: VWAP üstü trendde EMA21'e geri çekilme sonrası önceki tepeyi aşma → CALL", () => {
  const cl = [100, 100.2, 100.4, 100.6, 100.8, 101, 101.2, 101.4, 101.6, 101.8, 102, 102.2, 102.4, 101.95, 102.5];
  const bars = cl.map((c, i) => B(c, i, i ? cl[i - 1] : 100));
  bars[13].low = 101.0;                                             // önceki mum EMA21/VWAP bölgesine değdi
  const f = dayFeatures(bars), i = bars.length - 1;
  assert.ok(setupsAt(bars, f, i, 660, null).some(x => x.name === "PULLBACK" && x.dir === "C"));
});

test("ileriye bakma yok: karar, sonraki mumlar eklense de değişmez", () => {
  const cl = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) + i * 0.02);
  const bars = cl.map((c, i) => B(c, i, i ? cl[i - 1] : 100));
  for (let i = 8; i < 30; i++) {
    const full = setupsAt(bars, dayFeatures(bars), i, 600 + i * 5, null);
    const cut = bars.slice(0, i + 1);
    assert.deepEqual(full, setupsAt(cut, dayFeatures(cut), i, 600 + i * 5, null));
  }
});

test("sonuç: stop önceliği, hedef 2R, ufuk sonu", () => {
  const bars = [B(100, 0), { ts: 1, open: 100, high: 102.5, low: 98.9, close: 101 }];
  assert.equal(outcomeR(bars, 0, "C", 99, 6), -1);                 // aynı mumda ikisi → STOP
  assert.equal(outcomeR([B(100, 0), { ts: 1, open: 100, high: 102.1, low: 99.5, close: 102 }], 0, "C", 99, 6), 2);
  assert.ok(Math.abs(outcomeR([B(100, 0), { ts: 1, open: 100, high: 100.6, low: 99.6, close: 100.5 }], 0, "C", 99, 1) - 0.5) < 1e-9);
});

test("genişlik: sektörlerin VWAP üstü oranı; eksik veride null", () => {
  const up = Array.from({ length: 10 }, (_, i) => B(100 + i, i)), dn = Array.from({ length: 10 }, (_, i) => B(100 - i, i));
  const sec = { A: up, B: up, C: up, D: up, E: up, F: dn, G: dn, H: dn };
  const br = breadthSeries(up.map(b => b.ts), sec);
  assert.ok(Math.abs(br[9] - 5 / 8) < 1e-9);
  assert.equal(breadthSeries([0], { A: up })[0], null);
});

test("canlı izin listesi: yalnız eşiği geçen kurulum/yön/gün parçası; eski skor asla", () => {
  const rows = [
    { name: "PULLBACK", dir: "C", hor: 30, n: 300, m: 0.05, t: 1, part: { sabah: { n: 80, m: 0.35, t: 2.6 }, öğle: { n: 150, m: -0.2, t: -2 } } },
    { name: "RECLAIM", dir: "C", hor: 60, n: 120, m: 0.2, t: 2.2, part: {} },
    { name: "ESKİ_SKOR", dir: "C", hor: 30, n: 900, m: 0.3, t: 5, part: {} },
    { name: "FLUSH", dir: "P", hor: 30, n: 17, m: 0.5, t: 3, part: {} }];
  const a = buildAllow(rows);
  assert.deepEqual(a.map(x => `${x.name}|${x.part}`).sort(), ["PULLBACK|sabah", "RECLAIM|tümü"]);
  assert.ok(allowedFor(a, "PULLBACK", "C", 620)); assert.equal(allowedFor(a, "PULLBACK", "C", 720), null);
  assert.ok(allowedFor(a, "RECLAIM", "C", 900)); assert.equal(allowedFor([], "RECLAIM", "C", 900), null);
  assert.equal(partOf(689), "sabah"); assert.equal(partOf(700), "öğle"); assert.equal(partOf(900), "öğleden sonra");
});

test("gün tipi, yeni kurulumlar (dünkü tepe, boşluk), model ve gamma", async () => {
  const { dayType, setupsAt, dayFeatures, fitLogit, predLogit, auc, features, FEAT_NAMES } = await import("../bot/setups.mjs");
  const { gexLevels } = await import("../bot/gex.mjs");
  const { allowedFor, dtGroup, modelCheck } = await import("../bot/setuplive.mjs");
  const up = Array.from({ length: 14 }, (_, i) => ({ ts: i, open: 100 + i * 0.2, high: 100 + i * 0.2 + 0.25, low: 100 + i * 0.2 - 0.05, close: 100 + i * 0.2 + 0.2, volume: 1 }));
  assert.equal(dayType(up, 13, 4), "trend↑"); assert.equal(dayType(up, 5, 4), "erken");
  const flat = up.map((b, i) => ({ ...b, open: 100, high: 100.3, low: 99.8, close: 100 + (i % 2) * 0.1 }));
  assert.equal(dayType(flat, 13, 4), "yatay");
  // Dünkü tepenin İLK kırılımı
  const bars = up.map(b => ({ ...b })), f = dayFeatures(bars);
  const pdhSet = setupsAt(bars, f, 13, 640, null, { pdh: bars[12].close + 0.01 });
  assert.ok(pdhSet.some(x => x.name === "PDH" && x.dir === "C"));
  // Aşağı boşluk kapanışı (dünkü kapanış geri alındı)
  const g = Array.from({ length: 10 }, (_, i) => ({ ts: i, open: 99 + i * 0.12, high: 99 + i * 0.12 + 0.15, low: 99 + i * 0.12 - 0.1, close: 99 + i * 0.12 + 0.1, volume: 1 }));
  assert.ok(setupsAt(g, dayFeatures(g), 9, 620, null, { pdc: 100.1 }).some(x => x.name === "GAP" && x.dir === "C"));
  // Lojistik model öğrenebiliyor
  const X = [], y = [];
  for (let k = 0; k < 400; k++) { const v = (k % 20) / 10 - 1; X.push([1, v]); y.push(v > 0 ? 1 : 0); }
  const w = fitLogit(X, y, { iters: 300, lr: 0.5 });
  assert.ok(predLogit(w, [1, 0.8]) > 0.7 && predLogit(w, [1, -0.8]) < 0.3);
  assert.ok(auc(X.map(x => predLogit(w, x)), y) > 0.95);
  assert.equal(features(up, dayFeatures(up), 13, 640, { name: "PDH", dir: "C" }, { dt: "trend↑" }).length, FEAT_NAMES.length);
  assert.deepEqual(modelCheck(null, [1]), { p: null, ok: true });
  assert.equal(modelCheck({ use: true, w: [-5], thr: 0.5 }, [1]).ok, false);
  // Gün tipi grubuna göre izin
  const allow = [{ name: "PULLBACK", dir: "C", hor: 30, part: "tümü", dtg: "lehte", m: 0.2 }];
  assert.ok(allowedFor(allow, "PULLBACK", "C", 700, "trend↑")); assert.equal(allowedFor(allow, "PULLBACK", "C", 700, "yatay"), null);
  assert.equal(dtGroup("trend↓", "C"), "aleyhte");
  // Gamma: call duvarı fiyatın üstünde, put duvarı altında
  const legs = [];
  for (const K of [95, 97, 99, 100, 101, 103, 105]) { legs.push({ K, oi: K === 103 ? 9000 : 1000, iv: 0.2, T: 10 / 365, type: "C" }); legs.push({ K, oi: K === 97 ? 9000 : 1000, iv: 0.2, T: 10 / 365, type: "P" }); }
  const lv = gexLevels(legs, 100);
  assert.equal(lv.callWall, 103); assert.equal(lv.putWall, 97);
  assert.equal(gexLevels([], 100), null);
});
