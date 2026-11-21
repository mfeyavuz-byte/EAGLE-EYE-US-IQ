import { test } from "node:test";
import assert from "node:assert/strict";
import { isRegularHours, sessionFraction, nyDate } from "../data/market.mjs";
import { passes } from "../spot/scan.mjs";
import { fmtSignal, diversify } from "../bot/run.mjs";

test("opsiyon fikirlerinde yoğunlaşma koruması", () => {
  const mk = (sym, code, dir) => ({ sym, idea: { code, dir } });
  const list = ["A", "B", "C", "D", "E", "F", "G"].map(s => mk(s, "BEAR_PUT", -1)).concat([mk("Z", "IRON_CONDOR", 0)]);
  const out = diversify(list, 6).map(x => x.idea.code);
  assert.equal(out.filter(c => c === "BEAR_PUT").length, 3);          // en çok 3 aynı strateji
  assert.ok(out.includes("IRON_CONDOR"));                              // farklı yapı listede
  assert.equal(out.length, 4);                                         // kopya bahisler gönderilmez
});

test("seans saatleri: yaz saati (EDT)", () => {
  assert.equal(isRegularHours(new Date("2026-07-15T13:29:00Z")), false); // 09:29 NY
  assert.equal(isRegularHours(new Date("2026-07-15T13:30:00Z")), true);  // 09:30 NY
  assert.equal(isRegularHours(new Date("2026-07-15T20:00:00Z")), false); // 16:00 NY
});

test("seans saatleri: kış saati (EST) ve hafta sonu", () => {
  assert.equal(isRegularHours(new Date("2026-01-14T14:00:00Z")), false); // 09:00 NY
  assert.equal(isRegularHours(new Date("2026-01-14T14:45:00Z")), true);  // 09:45 NY
  assert.equal(isRegularHours(new Date("2026-01-17T16:00:00Z")), false); // Cumartesi
});

test("seans kesri ve NY tarihi", () => {
  assert.equal(sessionFraction(new Date("2026-07-15T16:45:00Z")), 0.5);  // 12:45 NY = yarı
  assert.equal(sessionFraction(new Date("2026-07-15T22:00:00Z")), 1);
  assert.equal(nyDate(new Date("2026-07-16T02:00:00Z")), "2026-07-15");  // UTC ertesi gün, NY hâlâ 15'i
});

const base = { sym: "X", signal: "AL", confidence: 80, adx: 30, htf: "YUKARI", htfNote: "", dip: 0, dollarVol: 1e9, volPace: 1, rsi: 55, rs60: 2 };
test("filtre: kaliteli AL geçer, zayıflar elenir", () => {
  assert.equal(passes(base), true);
  assert.equal(passes({ ...base, confidence: 50 }), false);
  assert.equal(passes({ ...base, adx: 10 }), false);
  assert.equal(passes({ ...base, rsi: 70 }), false);
  assert.equal(passes({ ...base, volPace: 0.4 }), false);
  assert.equal(passes({ ...base, dollarVol: 1e6 }), false);
  assert.equal(passes({ ...base, htf: "ASAGI" }), false);
  assert.equal(passes({ ...base, htf: "ASAGI", adx: 10, dip: 2 }), true);  // dip dönüşü muaf
  assert.equal(passes({ ...base, signal: "SAT", htf: "YUKARI" }), false);
});

test("SAT sinyalinde stop fiyatın üstünde, hedef altında", async () => {
  const { orientLevels } = await import("../spot/scan.mjs");
  const lv = orientLevels(100, "SAT", { stopLoss: 95, target1: 110, target2: 120 });
  assert.deepEqual(lv, { stopLoss: 105, target1: 90, target2: 80 });
  assert.deepEqual(orientLevels(100, "AL", { stopLoss: 95, target1: 110 }), { stopLoss: 95, target1: 110, target2: undefined });
});

test("sinyal satırı biçimi", () => {
  const s = fmtSignal({ ...base, price: 123.4, stopLoss: 118, target1: 131, rr: 1.4 });
  assert.match(s, /🟢 X \$123\.4 · güven %80/);
  assert.match(s, /R:R 1\.4/);
});
