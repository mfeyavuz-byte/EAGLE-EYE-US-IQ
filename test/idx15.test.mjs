import { test } from "node:test";
import assert from "node:assert/strict";
import { nyTs, pickIdxContract } from "../bot/idx15.mjs";

const mk = (closes, vol = 1000) => closes.map((c, i) => ({ ts: i * 3e5, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: vol }));

test("nyTs: yaz/kış saati doğru", () => {
  assert.equal(new Date(nyTs("2026-11-25", 9, 30)).toISOString(), "2026-11-25T14:30:00.000Z");   // EST
  assert.equal(new Date(nyTs("2026-07-15", 16, 0)).toISOString(), "2026-07-15T20:00:00.000Z");   // EDT
});

test("pickIdxContract: geniş spread'li ve uzak strike'lar elenir, deltaya en yakın seçilir", () => {
  const legs = [95, 99, 100, 101, 110].map(K => ({ strike: K, bid: Math.max(0.05, 100 - K + 1), ask: Math.max(0.06, 100 - K + 1.04) }));
  legs.push({ strike: 100.5, bid: 0.5, ask: 1.5 });                    // spread %100 → elenir
  const c = pickIdxContract(legs, "C", 100, 2 / 365, 0.04, 0, 0.5);
  assert.ok(c && [99, 100, 101].includes(c.K));
  assert.ok(c.spread <= 0.15);
});
