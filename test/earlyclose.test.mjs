import { test } from "node:test";
import assert from "node:assert/strict";
import { earlyCloseRule, closeTsOf, nyTs } from "../data/market.mjs";
import { capStop } from "../bot/idx15.mjs";
import { optValue } from "../bot/exits.mjs";

test("erken kapanış: Şükran Günü ertesi, 24 Aralık, 3 Temmuz; normal gün 16:00", async () => {
  assert.equal(earlyCloseRule("2026-11-27"), true);                 // 2026 Şükran Günü 26 Kasım → 27'si erken kapanış
  assert.equal(earlyCloseRule("2025-11-28"), true);
  assert.equal(earlyCloseRule("2026-11-20"), false);
  assert.equal(earlyCloseRule("2026-12-24"), true);
  assert.equal(earlyCloseRule("2026-07-03"), true);
  assert.equal(earlyCloseRule("2027-07-03"), false);                // Cumartesi
  assert.equal(await closeTsOf("2026-11-27"), Date.parse("2026-11-27T18:00:00Z"));   // 13:00 NY (Alpaca yoksa kural)
  assert.equal(await closeTsOf("2026-11-25"), Date.parse("2026-11-25T21:00:00Z"));   // 16:00 NY
  assert.equal(nyTs("2026-07-15", 13, 0), Date.parse("2026-07-15T17:00:00Z"));
});

test("zaman stopu kapanışa göre kısalır; 27 Kasım QQQ 647C çıkış değeri gerçek kapanışla", () => {
  const close = Date.parse("2026-11-27T18:00:00Z"), at1230 = Date.parse("2026-11-27T17:30:00Z");
  assert.equal(capStop(45, close, at1230), 25);                     // 30 dk kala → 25 dk
  assert.equal(capStop(45, close, close - 3 * 60e3), 5);            // en az 5
  assert.equal(capStop(30, close + 5 * 3600e3, at1230), 30);
  const it = { dir: "C", K: 647, iv: 0.25 }, at1255 = Date.parse("2026-11-27T17:55:00Z");
  const wrong = optValue(it, 647.27, at1255, Date.parse("2026-11-27T21:00:00Z"));   // eski hata: 16:00 varsayımı
  const right = optValue(it, 647.27, at1255, close);
  assert.ok(wrong > 1.0, `eski değer ${wrong}`);                    // mesajdaki ~$1.25 bu hatadan
  assert.ok(right < 0.5 && right >= 0.27, `doğru değer ${right}`);  // 5 dk kala ≈ içsel değer 0.27 + az zaman değeri
});
