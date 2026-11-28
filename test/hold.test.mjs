import { test } from "node:test";
import assert from "node:assert/strict";
import { indicators, holdPick, pickList, fmtHold, weekKey, holdUniverse } from "../bot/hold.mjs";
import { outcomeR } from "../bot/setups.mjs";
import { settleOne, fmtIdeaReport } from "../bot/ideabook.mjs";
import { PREF_KEYS } from "../bot/prefs.mjs";

const series = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { ts: i * 864e5, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 }; });

test("göstergeler: MA doğru, RSI 0–100, yükselen trendde ADX yüksek", () => {
  const up = series(300, i => 50 + i * 0.3 + Math.sin(i) * 0.5), ind = indicators(up);
  const i = 299, ma50 = up.slice(250).reduce((a, r) => a + r.close, 0) / 50;
  assert.ok(Math.abs(ind.ma50[i] - ma50) < 1e-9);
  assert.equal(ind.ma200[198], null);
  assert.ok(ind.rsi.slice(20).every(x => x >= 0 && x <= 100));
  assert.ok(ind.adx[i] > 20);
});

test("tutuş seçimi: yükselişte MOM seçer, düşüşte seçmez; ileriye bakmaz", () => {
  const up = series(320, i => 40 * Math.exp(i * 0.004) + Math.sin(i / 3)), down = series(320, i => 200 * Math.exp(-i * 0.003));
  const a = holdPick("MOM", up, indicators(up), 300, 0.05);
  assert.ok(a && a.rs > 0 && a.stop < up[300].close);
  assert.equal(holdPick("MOM", down, indicators(down), 300, 0), null);
  assert.equal(holdPick("MOM", up, indicators(up), 200, 0), null);                 // < 252 gün geçmiş
  const more = [...up, ...series(30, () => 1)];                                      // sonradan çöken veri eklense de karar aynı
  assert.deepEqual(holdPick("MOM", more, indicators(more), 300, 0.05), a);
  assert.ok(["S2", "S2H"].every(v => holdPick(v, down, indicators(down), 300, 0) === null));
});

test("liste: puan sırası, sektör başına en çok 2; mesaj sade", () => {
  const c = [["A", "T", 9], ["B", "T", 8], ["C", "T", 7], ["D", "F", 6], ["E", "H", 5]].map(([sym, sec, score]) => ({ sym, sec, score, price: 100, stop: 90 }));
  assert.deepEqual(pickList(c, 4).map(x => x.sym), ["A", "B", "D", "E"]);
  const t = fmtHold(pickList(c, 2), { variant: "MOM", test: { ex: 0.0127, win: 0.63 } });
  assert.match(t, /^📈 1–2 AY TUTUŞ \(6 ay momentum lideri\)\n/);
  assert.match(t, /\nA ~100\.00 · stop 90\.00\n/);
  assert.equal(fmtHold([], {}), null);
  assert.ok(PREF_KEYS.tutus);
});

test("hafta anahtarı ve evren", () => {
  assert.equal(weekKey("2026-11-30"), "2026-11-30");
  assert.equal(weekKey("2026-12-03"), "2026-11-30");
  assert.equal(weekKey("2026-12-06"), "2026-11-30");
  assert.equal(weekKey("2026-12-07"), "2026-12-07");
  const U = { meta: { A: { idx: "SP500", dv: 5 }, B: { idx: "SP500", dv: 9 }, C: { idx: "NDX", dv: 99 }, D: { idx: "SP500", dv: 0 } } };
  assert.deepEqual(holdUniverse(U, 5), ["B", "A"]);
});

test("varsayım testi: aynı mumda hedef+stop → varsayılan STOP, ters varsayımda HEDEF; canlı karnede işaretlenir", () => {
  const b = [{ close: 100, high: 100, low: 100 }, { close: 100, high: 103, low: 98 }];       // stop 99, hedef 102 aynı mumda
  assert.equal(outcomeR(b, 0, "C", 99, 3), -1);
  assert.equal(outcomeR(b, 0, "C", 99, 3, 2, true), 2);
  const b2 = [{ close: 100, high: 100, low: 100 }, { close: 101, high: 102.5, low: 99.5 }];  // yalnız hedef
  assert.equal(outcomeR(b2, 0, "C", 99, 3), 2);
  const now = Date.parse("2026-12-01T16:00:00Z"), it = { src: "fast", kind: "burst", sym: "SPY", dir: "C", ts: now - 40 * 60e3, S: 100, stop: 99, target: 102, hor: 30 };
  assert.ok(settleOne(it, [{ ts: it.ts + 60e3, high: 103, low: 98, close: 100 }], now));
  assert.equal(it.res, "STOP"); assert.equal(it.amb, true);
  assert.match(fmtIdeaReport({ fast: { ideas: [it] } }, now), /🔁 30 günde 1 fikirde hedef ve stop aynı 1 dk mumda/);
});
