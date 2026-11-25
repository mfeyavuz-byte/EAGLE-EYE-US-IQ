import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeAudit, freshPrice, ageTxt } from "../bot/liveaudit.mjs";

test("tazelik: zaman damgasız ya da eski fiyat kullanılmaz", () => {
  const now = 1e9;
  assert.equal(freshPrice({ price: 10, ts: now - 60e3 }, now), 10);
  assert.equal(freshPrice({ price: 10, ts: now - 10 * 60e3 }, now), null);
  assert.equal(freshPrice({ price: 10, ts: null }, now), null);
  assert.equal(freshPrice(null, now), null);
  assert.equal(ageTxt(30e3), "30 sn"); assert.equal(ageTxt(10 * 60e3), "10 dk");
});

test("denetim: hepsi taze → sorun yok; bayat/uyumsuz kaynak → sorun listelenir", () => {
  const good = { alpaca: true, iex: { SPY: { price: 600, ageMs: 5e3 }, QQQ: { price: 500, ageMs: 9e3 } }, barAgeMs: 40e3,
    yahoo: { price: 600.1, ageMs: 20e3 }, diffPct: -0.02, parityGap: 0.0004, vixy: { price: 40, ageMs: 30e3 }, scan: { live: 900, of: 1100, med: 2 } };
  assert.equal(judgeAudit(good, true).bad.length, 0);
  const bad = { ...good, iex: { SPY: { price: 600, ageMs: 600e3 } }, barAgeMs: 900e3, diffPct: 0.5, parityGap: 0.004 };
  const r = judgeAudit(bad, true);
  assert.ok(r.bad.length >= 4);
  assert.ok(r.lines.some(l => l.startsWith("⚠") && /QQQ: veri gelmedi/.test(l)));
  assert.equal(judgeAudit(bad, false).bad.filter(x => !/veri gelmedi/.test(x)).length, 0);   // seans dışında yaş sorun sayılmaz
});
