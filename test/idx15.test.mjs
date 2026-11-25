import { test } from "node:test";
import assert from "node:assert/strict";
import { idxSignal, nyTs, pickIdxContract } from "../bot/idx15.mjs";

const mk = (closes, vol = 1000) => closes.map((c, i) => ({ ts: i * 3e5, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: vol }));

test("nyTs: yaz/kış saati doğru", () => {
  assert.equal(new Date(nyTs("2026-11-25", 9, 30)).toISOString(), "2026-11-25T14:30:00.000Z");   // EST
  assert.equal(new Date(nyTs("2026-07-15", 16, 0)).toISOString(), "2026-07-15T20:00:00.000Z");   // EDT
});

test("idxSignal: güçlü yükselişte CALL, seviyeler 1:2", () => {
  const bars = mk(Array.from({ length: 30 }, (_, i) => 100 + i * 0.1));
  const s = idxSignal(bars, 103.2, { prevClose: 99, sma20: 97 }, { now: 15, prev: 16 });
  assert.equal(s.dir, "C");
  assert.ok(s.score >= 3);
  assert.ok(s.stop < 103.2 && s.target > 103.2);
  assert.ok(Math.abs((s.target - 103.2) - 2 * (103.2 - s.stop)) < 0.02);
});

test("idxSignal: güçlü düşüşte PUT; yatay piyasada NÖTR", () => {
  const down = idxSignal(mk(Array.from({ length: 30 }, (_, i) => 100 - i * 0.1)), 96.8, { prevClose: 101, sma20: 103 }, { now: 22, prev: 20 });
  assert.equal(down.dir, "P");
  assert.ok(down.stop > 96.8 && down.target < 96.8);
  const flat = idxSignal(mk(Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.05 : -0.05))), 100, { prevClose: 100, sma20: 100 }, null);
  assert.equal(flat.dir, null);
});

test("idxSignal: veri yoksa null", () => {
  assert.equal(idxSignal([], 100, null, null), null);
  assert.equal(idxSignal(mk([1, 2, 3]), 0, null, null), null);
});

test("pickIdxContract: geniş spread'li ve uzak strike'lar elenir, deltaya en yakın seçilir", () => {
  const legs = [95, 99, 100, 101, 110].map(K => ({ strike: K, bid: Math.max(0.05, 100 - K + 1), ask: Math.max(0.06, 100 - K + 1.04) }));
  legs.push({ strike: 100.5, bid: 0.5, ask: 1.5 });                    // spread %100 → elenir
  const c = pickIdxContract(legs, "C", 100, 2 / 365, 0.04, 0, 0.5);
  assert.ok(c && [99, 100, 101].includes(c.K));
  assert.ok(c.spread <= 0.15);
});
