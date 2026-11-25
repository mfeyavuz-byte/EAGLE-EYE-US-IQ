import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExit, fmtExit, optValue, ideaId } from "../bot/exits.mjs";
import { roundTrips, paperQty, orderId } from "../bot/optpaper.mjs";
import { tuneOne, tunedValue, TUNE } from "../bot/tune.mjs";
import { realizedMoves, atmStraddle, yahooTiming, straddleValue } from "../bot/earnings.mjs";
import { usDate, timeOf } from "../data/nasdaq.mjs";

const it = { src: "idx", sym: "SPY", dir: "C", ts: 0, S: 100, stop: 99, target: 102, tstop: 45, K: 100, exp: "2026-12-04", prem: 1.5, iv: 0.2 };

test("çıkış: stop önceliği, hedef, zaman, kapanış", () => {
  assert.equal(checkExit(it, { px: 100.5, hi: 101, lo: 99.8, now: 10 * 60e3 }), null);
  assert.equal(checkExit(it, { px: 101, hi: 102.2, lo: 98.9, now: 6e4 }).why, "STOP");      // ikisi birden → STOP
  assert.equal(checkExit(it, { px: 102.1, hi: 102.1, lo: 99.5, now: 6e4 }).why, "HEDEF");
  assert.equal(checkExit(it, { px: 100.4, hi: 100.6, lo: 99.6, now: 46 * 60e3 }).why, "ZAMAN");
  assert.equal(checkExit(it, { px: 100.4, now: 6e4, toCloseMin: 4 }).why, "KAPANIŞ");
  const put = { ...it, dir: "P", stop: 101, target: 98 };
  assert.equal(checkExit(put, { px: 97.9, hi: 100.2, lo: 97.9, now: 6e4 }).why, "HEDEF");
  assert.equal(checkExit(it, { px: 0, now: 6e4 }), null);
  assert.equal(ideaId(it), "idx-SPY-0");
  const v = optValue(it, 102, Date.parse("2026-12-01T15:00:00Z"), Date.parse("2026-12-04T21:00:00Z"));
  assert.ok(v > 2 && v < 4);
  assert.match(fmtExit(it, { why: "HEDEF", px: 102 }, v, true), /HEDEF[\s\S]*\+2\.00R[\s\S]*KAPAT[\s\S]*paper/);
});

test("sanal opsiyon: adet, emir kimliği, FIFO tur hesabı", () => {
  assert.equal(paperQty(2.5, 1000), 4); assert.equal(paperQty(15, 1000), 1); assert.equal(paperQty(40, 1000), 0); assert.equal(paperQty(0), 0);
  assert.ok(orderId("idx-BRK.B-1795636961000-extra-long-tail-xxxxxxxxxxxxxxxxxxx").length <= 48);
  const o = (side, qty, px, t, sym = "SPY261204C00600000") => ({ asset_class: "us_option", status: "filled", symbol: sym, side, filled_qty: String(qty), filled_avg_price: String(px), filled_at: t });
  const s = roundTrips([o("buy", 2, 1.0, "2026-12-01T15:00:00Z"), o("sell", 2, 1.5, "2026-12-01T15:30:00Z"),
    o("buy", 1, 2.0, "2026-12-01T16:00:00Z", "QQQ"), o("sell", 1, 1.0, "2026-12-01T16:30:00Z", "QQQ"), o("buy", 1, 3, "2026-12-01T17:00:00Z", "X")]);
  assert.equal(s.n, 2); assert.equal(s.wins, 1); assert.equal(Math.round(s.pnl), 0); assert.equal(s.open, 1);
  assert.ok(Math.abs(s.avgRet - 0) < 1e-9);                        // (+50% −50%) / 2
});

test("eşik ayarı: veri azsa varsayılan, kaybeden alt eşik sıkılaşır, bozuk dosya reddedilir", () => {
  const mk = (score, r, n) => Array.from({ length: n }, () => ({ res: r > 0 ? "HEDEF" : "STOP", r, score }));
  assert.equal(tuneOne(mk(3, 2, 10), TUNE.idx).value, 3);                                  // 10 < 40
  const ideas = [...mk(3, -1, 60), ...mk(4, 2, 25)];                                    // ≥3: (−60+50)/85 < 0
  const t = tuneOne(ideas, TUNE.idx);
  assert.equal(t.value, 3.5);                                                               // ≥3.5 → yalnız 4'lük kazananlar
  const bad = tuneOne(mk(4.5, -1, 50), TUNE.idx);
  assert.equal(bad.value, 4.5); assert.equal(bad.warn, true);
  assert.equal(tunedValue({ idx: 99 }, "idx"), 3); assert.equal(tunedValue({ fast: 4 }, "fast"), 4); assert.equal(tunedValue(null, "fast"), 3.5);
});

test("bilanço: gerçek tepki, ATM straddle, saat, tarih", () => {
  const day = (d, c) => ({ ts: Date.parse(d + "T14:30:00Z"), close: c });
  const daily = [day("2026-10-27", 100), day("2026-10-28", 101), day("2026-10-29", 110), day("2026-10-30", 111)];
  const m = realizedMoves(daily, ["2026-10-28"]);
  assert.ok(Math.abs(m[0] - (110 / 101 - 1)) < 1e-9);                                      // D+1 tepkisi daha büyük
  const leg = (K, bid, ask, sym) => ({ strike: K, bid, ask, sym });
  const s = atmStraddle([leg(95, 6, 6.2, "C95"), leg(100, 3, 3.1, "C100")], [leg(100, 2.9, 3, "P100"), leg(105, 6, 6.3, "P105")], 99);
  assert.equal(s.K, 100); assert.equal(s.occC, "C100"); assert.ok(Math.abs(s.cost - (3.05 + 2.95 + 0.3 * 0.2)) < 0.011);
  assert.equal(atmStraddle([], [], 100), null);
  assert.equal(straddleValue({ calls: [leg(100, 4, 4.2, "C100")], puts: [leg(100, 1, 1.2, "P100")] }, "C100", "P100").toFixed(2), "5.08");                                     // 5.2 − 0.3×0.4
  assert.deepEqual(yahooTiming(Date.parse("2026-10-28T20:05:00Z") / 1e3), { date: "2026-10-28", when: "amc" });
  assert.equal(yahooTiming(Date.parse("2026-10-28T11:00:00Z") / 1e3).when, "bmo");
  assert.equal(usDate("7/29/2026"), "2026-07-29"); assert.equal(timeOf("time-after-hours"), "amc"); assert.equal(timeOf("time-not-supplied"), null);
});
