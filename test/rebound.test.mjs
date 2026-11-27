import { test } from "node:test";
import assert from "node:assert/strict";
import { reboundSignal } from "../bot/rebound.mjs";
import { tradePlan, fmtPlan, fmtPlanLine } from "../bot/plans.mjs";

const day = (c, i) => ({ ts: i * 864e5, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1e6 });

test("aşırı satım dönüşü: 200g üstü yükselen hissede sert 4 günlük düşüş → aday; düşüş yoksa / 200g altıysa yok", () => {
  const up = Array.from({ length: 240 }, (_, i) => 100 + i * 0.3);
  const crash = [...up, 168, 163, 158, 153].map(day);
  const s = reboundSignal(crash, { deep: 2 });
  assert.ok(s && s.rsi2 < 5 && s.stop < 153 && s.target > 153);
  assert.equal(reboundSignal(up.map(day), { deep: 2 }), null);
  const down = Array.from({ length: 240 }, (_, i) => 200 - i * 0.3);
  assert.equal(reboundSignal([...down, 125, 122, 119, 116].map(day), { deep: 2 }), null);   // uzun vadeli düşüşte bıçak yakalanmaz
});

test("plan: eğilim, giriş fiyatın doğru tarafında, 1:2 hedef/stop, biçim", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ ts: i * 3e5, open: 100 + i * 0.1, high: 100 + i * 0.1 + 0.08, low: 100 + i * 0.1 - 0.08, close: 100 + i * 0.1 + 0.05, volume: 1000 }));
  const p = tradePlan(bars);
  assert.equal(p.trend, "↑");
  assert.ok(p.call.entry > p.S && p.put.entry < p.S);
  assert.ok(Math.abs((p.call.target - p.call.entry) - 2 * (p.call.entry - p.call.stop)) < 0.02);
  assert.ok(Math.abs((p.put.entry - p.put.target) - 2 * (p.put.stop - p.put.entry)) < 0.02);
  assert.match(fmtPlan("SPY", p, "0DTE 102C ~$1.20"), /^SPY [\d.]+ · ↑ yükseliş eğilimi\n  🟢 CALL [\d.]+ üstü → hedef [\d.]+ · stop [\d.]+\n  🔴 PUT [\d.]+ altı → hedef [\d.]+ · stop [\d.]+\n  Kontrat \(CALL\): 0DTE 102C ~\$1\.20$/);
  assert.match(fmtPlanLine("NVDA", p), /^NVDA [\d.]+ ↑ · CALL >[\d.]+ h[\d.]+ s[\d.]+ · PUT <[\d.]+ h[\d.]+ s[\d.]+$/);
  assert.equal(tradePlan([]), null);
});
