import { test } from "node:test";
import assert from "node:assert/strict";
import { pickExpiry, occ, strikeCands, walk, summarize, retOf } from "../options/backtest.mjs";
import { bs } from "../options/bs.mjs";

test("vade: girişten ≥ 35 gün sonraki ilk aylık (3. Cuma)", () => {
  assert.equal(pickExpiry("2024-03-01"), "2024-04-19");   // 15 Mart < 35 gün → Nisan
  assert.equal(pickExpiry("2024-03-11"), "2024-04-19");
  assert.equal(pickExpiry("2024-03-20"), "2024-05-17");   // 19 Nisan = 30 gün → Mayıs
  assert.equal(pickExpiry("2025-11-20"), "2026-01-16");   // yıl geçişi
});

test("OCC kontrat sembolü", () => {
  assert.equal(occ("AAPL", "2024-04-19", "P", 140), "AAPL240419P00140000");
  assert.equal(occ("BRK.B", "2025-01-17", "C", 452.5), "BRKB250117C00452500");
});

test("strike adayları delta hedefine yakın", () => {
  const S = 100, T = 45 / 365, s = 0.3;
  const ks = strikeCands("C", S, T, s, 0.6);
  assert.equal(ks.length, 8);
  const d0 = bs("C", S, ks[0], T, 0.045, 0, s).delta;
  assert.ok(Math.abs(d0 - 0.6) < 0.05, `delta ${d0}`);                   // $2.5 strike adımında en yakın
  const kp = strikeCands("P", S, T, s, 0.6)[0];
  assert.ok(kp > S, "0.6 deltalı put ITM (strike > fiyat)");
});

test("yürüyüş: kâr hedefi / zarar durdur / süre kuralları", () => {
  const b = (d, c) => ({ d, c });
  assert.equal(walk([b("2024-03-04", 2), b("2024-03-05", 2.5), b("2024-03-06", 4.1)], "2024-03-04", "2024-04-19").reason, "kâr hedefi");
  assert.equal(walk([b("2024-03-04", 2), b("2024-03-05", 0.99)], "2024-03-04", "2024-04-19").reason, "zarar durdur");
  const w = walk([b("2024-03-04", 2), b("2024-03-20", 2.2), b("2024-03-29", 2.1)], "2024-03-04", "2024-04-19");
  assert.equal(w.reason, "süre"); assert.equal(w.exit.d, "2024-03-29");   // vadeye 21 gün
  assert.equal(walk([b("2024-03-05", 2)], "2024-03-04", "2024-04-19"), null);   // giriş günü işlem yok → sonraki gün girer ama çıkış yok
});

test("özet: maliyet K/Z'yi düşürür", () => {
  const leg = { entry: { d: "2024-03-04", c: 2 }, exit: { d: "2024-03-14", c: 3 } };
  assert.equal(retOf(leg, 0), 0.5);
  const s0 = summarize([leg], 0), s3 = summarize([leg], 0.03);
  assert.equal(s0.pnl, 100);
  assert.ok(s3.pnl < s0.pnl && s3.pnl > 80);
  assert.equal(s0.days, 10);
});

test("çıkış kuralı varyantları aynı fiyat yolunda farklı sonuç verir", async () => {
  const { walkPath, RULE_VARIANTS } = await import("../options/backtest.mjs");
  const path = [["2024-03-04", 2], ["2024-03-05", 0.9], ["2024-03-12", 3.5], ["2024-03-20", 4.4], ["2024-03-29", 5]];
  const by = Object.fromEntries(RULE_VARIANTS.map(r => [r.name, walkPath(path, "2024-04-19", r)]));
  assert.equal(by["CANLI: +%100 / −%50 / 21g"].reason, "zarar durdur");            // 0.9 → −%55
  assert.equal(by["stopsuz: +%100 / — / 21g"].exit.c, 4.4);                         // +%120 → kâr hedefi
  assert.equal(by["geniş stop: +%100 / −%70 / 21g"].reason, "kâr hedefi");
  assert.equal(by["yalnız süre: — / — / 21g"].exit.d, "2024-03-29");                // vadeye 21 gün
});
