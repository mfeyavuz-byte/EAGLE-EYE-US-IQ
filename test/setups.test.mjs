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
