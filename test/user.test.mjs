import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPrefCmd, applyAcctCmd, isOn, sizeLine, prefsButtons } from "../bot/prefs.mjs";
import { parseBuy, checkPos, parseExp, fmtPositions } from "../bot/mypos.mjs";
import { pmMovers, fmtPmMovers, fmtEod } from "../bot/daily.mjs";

test("ayarlar: varsayılan açık, aç/kapat, bilinmeyen ayar, düğmeler", () => {
  assert.equal(isOn(null, "saatlik"), true);
  let r = applyPrefCmd(null, ["saatlik", "kapat"]);
  assert.equal(r.changed, true); assert.equal(isOn(r.p, "saatlik"), false);
  r = applyPrefCmd(r.p, ["saatlik"]);                                   // dokun → tersine çevir
  assert.equal(isOn(r.p, "saatlik"), true);
  assert.equal(applyPrefCmd(r.p, ["yok"]).changed, false);
  assert.ok(prefsButtons(r.p).flat().some(b => b.data === "/ayarlar saatlik"));
});

test("hesap ve kontrat sayısı", () => {
  const r = applyAcctCmd(null, ["25000", "1"]);
  assert.equal(r.p.acct, 25000); assert.equal(r.p.risk, 0.01);
  assert.equal(applyAcctCmd(null, ["abc"]).changed, false);
  assert.match(sizeLine(r.p, 2.0, 1.0), /^Boyut: 2 kontrat/);              // stopta kontrat başı $100 → $250 bütçe → 2
  assert.match(sizeLine(r.p, 10, 1), /1 kontrat bile riskinden büyük/);
  assert.equal(sizeLine({ acct: null }, 2, 1), null);
});

test("pozisyon: ayrıştırma ve tek seferlik uyarılar", () => {
  assert.equal(parseExp("04.12", "2026-11-30"), "2026-12-04");
  assert.equal(parseExp("01.01", "2026-11-30"), "2027-01-01");
  const p = { ...parseBuy(["SPY", "728C", "04.12", "4", "2", "hedef", "735", "stop", "720"], "2026-11-30"), alerts: {}, id: "x" };
  assert.deepEqual([p.K, p.type, p.exp, p.px, p.qty, p.tgtU, p.stopU], [728, "C", "2026-12-04", 4, 2, 735, 720]);
  assert.deepEqual(checkPos(p, { mid: 1.9, S: 725, today: "2026-11-30" }).map(a => a.key), ["sl"]);
  assert.deepEqual(checkPos(p, { mid: 8.2, S: 736, today: "2026-11-30" }).map(a => a.key).sort(), ["tp", "tu"]);
  p.alerts.sl = 1;
  assert.deepEqual(checkPos(p, { mid: 1.5, S: 719, today: "2026-12-04", toCloseMin: 20 }).map(a => a.key).sort(), ["ex", "su"]);   // sl bir daha yok
  assert.match(fmtPositions([p], { x: 5 }), /SPY 728C 04\.12 ×2 · giriş \$4 · şimdi \$5\.00 \(\+%25, \+\$200\)/);
});

test("açılış öncesi hareketliler ve gün sonu karnesi", () => {
  const now = 1e12, q = { AAA: { price: 110, prev: 100, ts: now - 60e3 }, BBB: { price: 95, prev: 100, ts: now - 60e3 },
    CCC: { price: 101, prev: 100, ts: now - 60e3 }, OLD: { price: 120, prev: 100, ts: now - 3600e3 }, PENNY: { price: 5, prev: 4, ts: now } };
  const m = pmMovers(q, now, 8);
  assert.deepEqual(m.map(x => x.sym), ["AAA", "BBB"]);
  assert.ok(m[0].dir === "C" && m[0].target > m[0].entry && m[0].stop < m[0].entry);
  assert.ok(m[1].dir === "P" && m[1].target < m[1].entry && m[1].stop > m[1].entry);
  assert.match(fmtPmMovers(m), /↑ AAA \+%10\.0/);
  const ideas = [{ res: "HEDEF", r: 2 }, { res: "STOP", r: -1 }, { res: null }];
  assert.match(fmtEod(ideas, { n: 2, pnl: 150 }), /3 fikir · 🎯 1 hedef · 🛑 1 stop · ⏱ 0 süre · net \+1\.0R · 1 sonuçlanmadı\n🧾 Sanal hesap: 2 işlem · net \+\$150/);
  assert.match(fmtEod([], null), /bugün ölçülmüş fikir yoktu/);
});
