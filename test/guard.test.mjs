import { test } from "node:test";
import assert from "node:assert/strict";
import { keyState, pausedList, guardDecision, computeLead, isLeader, corrRet, clusterMembers, ideaKey, GUARD } from "../bot/guard.mjs";
import { sizeLine } from "../bot/prefs.mjs";
import { fmtIdeaReport } from "../bot/ideabook.mjs";

const D = 864e5, NOW = Date.parse("2026-12-01T16:00:00Z");
const mk = (rs, { src = "setup", setup = "RECLAIM", kind = "burst", dir = "C", t0 = NOW - 20 * D, step = D / 2 } = {}) =>
  rs.map((r, i) => ({ src, setup, kind, dir, ts: t0 + i * step, res: r > 0 ? "HEDEF" : "STOP", r }));

test("durdurma: ≥10 fikir ve son 10 negatif → 30 gün durur, sonra ×0.6 deneme", () => {
  const ideas = mk([2, 2, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1]);           // son 10 = 2, −1×9 = −7R
  const k = ideaKey(ideas[0]), s = keyState(ideas, k, NOW);
  assert.ok(s.paused, "durmalı"); assert.equal(s.mult, 0);
  assert.ok(s.paused.daysLeft > 0 && s.paused.daysLeft <= 30);
  const later = keyState(ideas, k, NOW + 40 * D);
  assert.equal(later.paused, null); assert.equal(later.trial, true); assert.equal(later.mult, GUARD.TRIAL);
  assert.equal(pausedList(ideas, NOW).length, 1);
  assert.equal(pausedList(ideas, NOW + 40 * D).length, 0);
});

test("durdurma: 10'dan az fikir ya da son 10 pozitif → durmaz", () => {
  assert.equal(keyState(mk([-1, -1, -1, -1, -1, -1, -1, -1, -1]), "setup|RECLAIM|C", NOW).paused, null);
  const ok = mk([-1, -1, -1, -1, -1, -1, 2, 2, 2, 2, -1]);
  assert.equal(keyState(ok, "setup|RECLAIM|C", NOW).paused, null);
  // başka yön / başka tür etkilenmez
  assert.equal(keyState(mk(Array(12).fill(-1)), "setup|RECLAIM|P", NOW).n, 0);
});

test("adet çarpanı: küçükte nötr, iyi karnede ×1.3, kötüde ×0.6 (sıfıra çekilerek)", () => {
  assert.equal(keyState(mk([2, 2, 2, 2]), "setup|RECLAIM|C", NOW).mult, 1);           // < 5 fikir
  assert.equal(keyState(mk([2, 2, -1, 2, -1, 2, 2, -1, 2, 2]), "setup|RECLAIM|C", NOW).mult, 1.3);   // Σ=11 /20 = 0.55
  assert.equal(keyState(mk([2, -1, -1, -1, -1, -1, 2, -1]), "setup|RECLAIM|C", NOW).mult, 1);        // Σ=−2 /18 = −0.11 → nötr
  assert.equal(keyState(mk(Array(8).fill(-1)), "setup|RECLAIM|C", NOW).mult, 0.6);                    // Σ=−8 /18 = −0.44
});

test("sizeLine çarpanla bütçeyi büyütür/küçültür", () => {
  const p = { acct: 25000, risk: 0.01 };
  assert.match(sizeLine(p, 1.0, 0.5), /^Boyut: 5 kontrat/);
  assert.match(sizeLine(p, 1.0, 0.5, 0.5), /^Boyut: 2 kontrat/);
  assert.match(sizeLine(p, 1.0, 0.5, 1.3), /^Boyut: 6 kontrat/);
});

const bar = (ts, o, c) => ({ ts, open: o, close: c, high: Math.max(o, c), low: Math.min(o, c) });
const SECS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
function leadBars(spyRet, over = {}) {
  const b = { SPY: [bar(0, 100, 100), bar(1, 100, 100 * (1 + spyRet))] };
  for (const s of SECS) { const r = over[s] ?? spyRet; b[s] = [bar(0, 50, 50), bar(1, 50, 50 * (1 + r))]; }
  return b;
}

test("lider sektör: endeks düşerken uçan sektör CALL için lider, PUT için değil", () => {
  const lead = computeLead(leadBars(-0.01, { XLK: 0.012 }), NOW);
  assert.ok(isLeader(lead, "XLK", "C"));
  assert.ok(!isLeader(lead, "XLK", "P"));
  assert.ok(!isLeader(lead, "XLF", "C"));                       // endeksle aynı → lider değil
  assert.ok(!isLeader(lead, "MKT", "C"));
  const weak = computeLead(leadBars(0.005, { XLE: -0.012 }), NOW);
  assert.ok(isLeader(weak, "XLE", "P"));
});

test("yığılma: normal kümede 2. fikir yarım, 3. yok; lider sektörde 3 fikre izin", () => {
  const open = [{ sym: "NVDA", dir: "C", ts: NOW - 10 * 60e3 }];
  const flat = computeLead(leadBars(0.001), NOW);
  let g = guardDecision({ src: "fast", kind: "burst", sym: "AMD", dir: "C" }, { ideas: [], open, lead: flat, now: NOW });
  assert.equal(g.ok, true); assert.equal(g.mult, 0.5); assert.match(g.tag, /aynı küme: NVDA/);
  g = guardDecision({ src: "fast", kind: "burst", sym: "AMD", dir: "C" }, { ideas: [], open: [...open, { sym: "MU", dir: "C" }], lead: flat, now: NOW });
  assert.equal(g.ok, false);
  const hot = computeLead(leadBars(-0.008, { XLK: 0.01 }), NOW);
  g = guardDecision({ src: "fast", kind: "burst", sym: "AMD", dir: "C" }, { ideas: [], open, lead: hot, now: NOW });
  assert.equal(g.mult, 1); assert.match(g.tag, /lider sektör/);
  g = guardDecision({ src: "fast", kind: "burst", sym: "AVGO", dir: "C" }, { ideas: [], open: [...open, { sym: "MU", dir: "C" }], lead: hot, now: NOW });
  assert.equal(g.ok, true); assert.equal(g.mult, 0.5);
  g = guardDecision({ src: "fast", kind: "burst", sym: "AVGO", dir: "C" }, { ideas: [], open: [...open, { sym: "MU", dir: "C" }, { sym: "AMD", dir: "C" }], lead: hot, now: NOW });
  assert.equal(g.ok, false);
});

test("yığılma: ters yön ve farklı sektör sayılmaz; SPY+QQQ aynı küme", () => {
  const open = [{ sym: "NVDA", dir: "P" }, { sym: "JPM", dir: "C" }];
  const g = guardDecision({ src: "fast", kind: "burst", sym: "AMD", dir: "C" }, { ideas: [], open, now: NOW });
  assert.equal(g.mult, 1); assert.equal(g.tag, null);
  const q = guardDecision({ src: "setup", setup: "RECLAIM", sym: "QQQ", dir: "C" }, { ideas: [], open: [{ sym: "SPY", dir: "C" }], now: NOW });
  assert.equal(q.mult, 0.5);
});

test("sektörü bilinmeyen sembol: korelasyonla kümelenir", () => {
  const a = [], b = [], c = [];
  let pa = 100, pb = 50, pc = 20;
  for (let i = 0; i < 61; i++) {
    const r = Math.sin(i * 1.7) * 0.002;
    pa *= 1 + r; pb *= 1 + r * 1.1; pc *= 1 + Math.cos(i * 2.9) * 0.002;
    a.push({ ts: i * 60e3, close: pa }); b.push({ ts: i * 60e3, close: pb }); c.push({ ts: i * 60e3, close: pc });
  }
  assert.ok(corrRet(a, b) > 0.95);
  assert.ok(Math.abs(corrRet(a, c)) < 0.8);
  const bars = { ZZZ: a, YYY: b, XXX: c }, corrOf = (x, y) => corrRet(bars[x], bars[y]);
  assert.equal(clusterMembers({ sym: "ZZZ", dir: "C" }, [{ sym: "YYY", dir: "C" }], corrOf).length, 1);
  assert.equal(clusterMembers({ sym: "ZZZ", dir: "C" }, [{ sym: "XXX", dir: "C" }], corrOf).length, 0);
});

test("durdurulmuş tür gönderilmez; karne raporunda görünür", () => {
  const ideas = mk(Array(12).fill(-1), { src: "fast", kind: "burst" });
  const g = guardDecision({ src: "fast", kind: "burst", sym: "TSLA", dir: "C" }, { ideas, open: [], now: NOW });
  assert.equal(g.ok, false); assert.match(g.why, /durdurulmuş/);
  assert.match(fmtIdeaReport({ fast: { ideas } }, NOW), /⏸ Ani hareket CALL alarmı durdurulmuş/);
});
