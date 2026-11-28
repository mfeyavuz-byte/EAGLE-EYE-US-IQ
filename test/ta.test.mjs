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

import { tfMatch, sectorLead20, settleTa, fmtTaBook } from "../bot/ta.mjs";
import { keyState, ideaKey, keyLabel } from "../bot/guard.mjs";

test("kesişim: momentum / lider sektör / ikisi; sektör liderliği ilk 3 ve SPY'dan iyi", () => {
  const sg = { dir: "C", trend: 1 };
  assert.ok(tfMatch("tümü", sg, {}) && tfMatch("trendle", sg, {}));
  assert.ok(!tfMatch("mom", sg, {}) && tfMatch("mom", sg, { mom: true }));
  assert.ok(!tfMatch("ikisi", sg, { mom: true }) && tfMatch("ikisi", sg, { mom: true, lead: true }));
  const L = sectorLead20({ SPY: 0.01, XLK: 0.05, XLF: 0.03, XLE: 0.02, XLV: 0.015, XLU: -0.01 });
  assert.deepEqual([L.XLK, L.XLF, L.XLE, L.XLV, L.XLU], [true, true, true, false, false]);
  assert.deepEqual(sectorLead20({ SPY: 0.05, XLK: 0.01 }), { XLK: false });
});

test("formasyon canlı karnesi: hedef/stop/süre; bugünün mumu sayılmaz; 200 WMA kapanışla", () => {
  const day = k => Date.parse("2026-11-02T20:00:00Z") + k * 864e5;
  const rows = Array.from({ length: 30 }, (_, k) => ({ ts: day(k), open: 100, high: 101, low: 99, close: 100 }));
  const a = { src: "ta", name: "EW2", dir: "C", sym: "X", d: "2026-11-02", S: 100, stop: 98, target: 104 };
  rows[3].high = 105;
  assert.ok(settleTa(a, rows, "2026-12-30")); assert.equal(a.res, "HEDEF"); assert.equal(a.r, 2);
  const b = { src: "ta", name: "EW2", dir: "C", sym: "X", d: "2026-11-02", S: 100, stop: 98, target: 104 };
  assert.equal(settleTa(b, rows, "2026-11-05"), false);                       // ufuk dolmadı, hedef/stop yok (bugünün mumu hariç)
  const w = { src: "wma", name: "UP", dir: "C", sym: "X", d: "2026-11-02", S: 100, stop: 97, target: null };
  rows[5].close = 96;
  assert.ok(settleTa(w, rows, "2026-12-30")); assert.equal(w.res, "STOP"); assert.equal(w.r, -1.33);
  const t = fmtTaBook([a, w, b]);
  assert.match(t, /EW2 CALL: 1 sonuçlandı · isabet %100 · ort \+2\.00R · açık 1/);
  assert.match(t, /200 WMA UP: 1 sonuçlandı/);
});

test("formasyon türü 10 kayıptan sonra durur", () => {
  const recs = Array.from({ length: 12 }, (_, k) => ({ src: "ta", name: "ABC", dir: "C", ts: Date.now() - (20 - k) * 864e5, d: "2026-11-01", res: "STOP", r: -1 }));
  const noTs = recs.map(({ ts, ...x }) => ({ ...x, d: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10) }));
  assert.ok(keyState(noTs, "ta|ABC|C").paused);                                // yalnız tarihli kayıtta da durdurma çalışır
  assert.equal(ideaKey(recs[0]), "ta|ABC|C");
  assert.ok(keyState(recs, "ta|ABC|C").paused);
  assert.equal(keyLabel("ta|ABC|C"), "ABC CALL formasyonu");
});
