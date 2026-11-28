import { test } from "node:test";
import assert from "node:assert/strict";
import { zigzag, prep, taSignals, wmaArr, wmaEvent, fmtTa, fmtWma, TA } from "../bot/ta.mjs";
import { PREF_KEYS } from "../bot/prefs.mjs";

// Fiyat yolunu doğrusal parçalarla kur: [[gün sayısı, hedef fiyat], ...]
function path(start, legs) {
  const c = [start];
  for (const [n, to] of legs) { const from = c.at(-1); for (let k = 1; k <= n; k++) c.push(from + (to - from) * k / n); }
  return c.map((x, i) => ({ ts: i * 864e5, open: x, high: x * 1.004, low: x * 0.996, close: x, volume: 1e6 }));
}

test("zigzag: dönüşler doğru sırada, teyit dönüşten sonra, ileriye bakmıyor", () => {
  const r = path(100, [[80, 100], [20, 130], [15, 115], [25, 160], [12, 150]]);
  const P = prep(r), pv = P.piv;
  assert.ok(pv.length >= 3);
  for (let k = 1; k < pv.length; k++) assert.notEqual(pv[k].t, pv[k - 1].t);
  assert.ok(pv.every(p => p.c > p.i));
  const cut = r.slice(0, 120), pv2 = prep(cut).piv;                     // kısaltılmış veride teyitli dönüşler aynı
  assert.deepEqual(pv2.filter(p => p.c < 120), pv.filter(p => p.c < 120));
});

test("Elliott 2. dalga: 1. dalga + %50 geri çekilme → CALL; düşüşte aynası PUT", () => {
  const up = path(100, [[80, 100], [10, 96], [20, 130], [12, 115], [20, 128]]);
  const P = prep(up), hits = [];
  for (let i = 60; i < up.length; i++) for (const s of taSignals(up, P, i)) hits.push({ i, ...s });
  const ew2 = hits.find(h => h.name === "EW2" && h.dir === "C");
  assert.ok(ew2, "EW2 CALL bulunmalı");
  assert.ok(ew2.stop < ew2.S && ew2.target > ew2.S);
  const dn = path(200, [[80, 200], [10, 204], [20, 170], [12, 185], [20, 172]]);
  const Q = prep(dn), h2 = [];
  for (let i = 60; i < dn.length; i++) for (const s of taSignals(dn, Q, i)) h2.push(s);
  assert.ok(h2.some(h => h.name === "EW2" && h.dir === "P" && h.stop > h.S && h.target < h.S));
});

test("200 haftalık ortalama: yukarı kırılım, aşağı kırılım, ilk geliş", () => {
  const mkW = cs => cs.map((c, i) => ({ ts: i * 7 * 864e5, open: c, high: c * 1.01, low: c * 0.99, close: c }));
  const base = Array.from({ length: 200 }, () => 100);
  let w = mkW([...base, ...Array(10).fill(90), 105]), m = wmaArr(w);
  assert.equal(wmaEvent(w, m, w.length - 1)?.ev, "UP");
  w = mkW([...base, ...Array(10).fill(110), 95]); m = wmaArr(w);
  assert.equal(wmaEvent(w, m, w.length - 1)?.ev, "DN");
  const up = [...base, ...Array(30).fill(0).map((_, k) => 104 + k * 0.5), 103];
  w = mkW(up); w[w.length - 1].low = 101; m = wmaArr(w);
  assert.equal(wmaEvent(w, m, w.length - 1)?.ev, "TOUCH");
  w = mkW([...base, ...Array(10).fill(90), 95]); m = wmaArr(w);
  assert.equal(wmaEvent(w, m, w.length - 1), null);                      // altta kaldı → olay yok
});

test("mesajlar sade; ayarlar var", () => {
  const t = fmtTa([{ sym: "NVDA", dir: "C", name: "EW2", S: 180.5, target: 195, stop: 176.2, contract: "02.01 180C ~$6.10", a: { w: 0.45, m: 0.089 } }]);
  assert.match(t, /^📐 TEKNİK FORMASYONLAR\n🟢 NVDA CALL AL — Elliott: 2\. dalga bitti/);
  assert.match(t, /Giriş ~180\.5 · Hedef 195\.0 · Stop 176\.2 · 02\.01 180C ~\$6\.10 \(test: isabet %45 · \+0\.089R\)/);
  const w = fmtWma([{ sym: "AAPL", ev: "DN", dir: "P", px: 170, wma: 175, d: -0.0286 }], { DN: { n: 2127, x13: -0.0018 } });
  assert.match(w, /🔴 AAPL PUT AL — 200 haftalık ortalamayı AŞAĞI kırdı/);
  assert.match(w, /stop: haftalık kapanış 180\.3 üstü/);
  assert.match(w, /zayıf, küçük tut/);
  assert.equal(fmtTa([]), null);
  assert.ok(PREF_KEYS.formasyon && PREF_KEYS.wma200);
  assert.equal(TA.WMA_SIDE, 8);
});
