import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvents, nearEvent, fmtMacroDay, eventsOn } from "../bot/macro.mjs";
import { addIdea, settleOne, ideaStats, fmtIdeaReport } from "../bot/ideabook.mjs";
import { applyEdge, weakQuality } from "../bot/edge.mjs";
import { headlineScore, newsSentiment, newsTag } from "../bot/news.mjs";

test("makro: yalnız USD+High, FOMC yedeği eklenir ve kopyalanmaz", () => {
  const raw = [{ country: "USD", impact: "High", date: "2026-12-11T08:30:00-05:00", title: "CPI m/m" },
    { country: "EUR", impact: "High", date: "2026-12-11T08:00:00-05:00", title: "ECB" },
    { country: "USD", impact: "Low", date: "2026-12-11T10:00:00-05:00", title: "x" },
    { country: "USD", impact: "High", date: "2026-12-09T14:00:00-05:00", title: "Federal Funds Rate" }];
  const fomc = Date.parse("2026-12-09T19:00:00Z");
  const ev = parseEvents(raw, [fomc]);
  assert.deepEqual(ev.map(e => e.title), ["Federal Funds Rate", "CPI m/m"]);
  assert.equal(eventsOn(ev, "2026-12-11").length, 1);
  assert.match(fmtMacroDay(ev, "2026-12-11"), /08:30 NY CPI/);
  assert.equal(fmtMacroDay(ev, "2026-12-10"), null);
  assert.ok(nearEvent(ev, Date.parse("2026-12-11T13:10:00Z"), 45));        // 08:10 NY → 20 dk sonra CPI
  assert.equal(nearEvent(ev, Date.parse("2026-12-11T16:00:00Z"), 45), null);
  assert.equal(parseEvents(null, [fomc]).length, 1);                        // takvim yoksa FOMC yedeği
});

test("karne: hedef/stop/süre, aynı mumda ikisi = STOP, ufuk dolmadan dokunulmaz", () => {
  const b = []; addIdea(b, { sym: "SPY", dir: "C", ts: 0, S: 100, stop: 99, target: 102, hor: 30 });
  const it = b.ideas[0];
  assert.equal(settleOne(it, [], 10 * 60e3), false);
  assert.equal(settleOne(it, [{ ts: 6e4, high: 102.1, low: 99.5, close: 102 }], 31 * 60e3), true);
  assert.equal(it.res, "HEDEF"); assert.equal(it.r, 2);
  const p = { sym: "Q", dir: "P", ts: 0, S: 100, stop: 101, target: 98, hor: 30, res: null };
  settleOne(p, [{ ts: 6e4, high: 101.2, low: 97.9, close: 99 }], 31 * 60e3);
  assert.equal(p.res, "STOP"); assert.equal(p.r, -1);
  const t = { sym: "Q", dir: "C", ts: 0, S: 100, stop: 99, target: 102, hor: 30, res: null };
  settleOne(t, [{ ts: 6e4, high: 100.6, low: 99.6, close: 100.5 }], 31 * 60e3);
  assert.equal(t.res, "SÜRE"); assert.equal(t.r, 0.5);
  const s = ideaStats([it, p, t]);
  assert.equal(s.n, 3); assert.equal(s.hit, 1); assert.ok(Math.abs(s.avgR - 0.5) < 1e-9);
  assert.match(fmtIdeaReport({ idx: { ideas: [it] }, fast: {} }, 1e6), /15 dk SPY\/QQQ/);
});

test("Faz 7: zayıf kalite/sektör sona iner, sıra kararlı, SAT güçlü sektörde sona iner", () => {
  assert.equal(weakQuality({ margin: -0.1 }), true);
  assert.equal(weakQuality({ margin: 0.1, roe: 0.2, fcf: 1, de: 50 }), false);
  assert.equal(weakQuality({ margin: 0.1, de: 400 }), true);
  assert.equal(weakQuality(null), null);
  const sig = [["A", "AL"], ["B", "AL"], ["C", "AL"], ["D", "SAT"], ["E", "SAT"]].map(([sym, signal]) => ({ sym, signal }));
  const sec = { A: "Energy", B: "Technology", C: "Technology", D: "Technology", E: "Utilities" };
  const q = { A: { margin: 0.2 }, B: { margin: -0.3 }, C: { margin: 0.2 } };
  const out = applyEdge(sig, { secOf: s => sec[s], sectors: { top: ["XLK", "XLC", "XLY"], bottom: ["XLE", "XLU", "XLP"] }, qualOf: s => q[s] });
  assert.deepEqual(out.map(s => s.sym), ["C", "A", "B", "E", "D"]);
  assert.match(out[0].edgeTag, /güçlü sektör XLK/);
  assert.match(out.find(s => s.sym === "D").edgeTag, /güçlü sektörde SAT/);
});

test("haber duygusu: yön, olumsuzlama, etiket eşiği", () => {
  assert.ok(headlineScore("Nvidia beats estimates, raises guidance") > 0);
  assert.ok(headlineScore("Tesla shares plunge after delivery miss") < 0);
  assert.equal(headlineScore("Apple to hold event in September"), 0);
  assert.ok(headlineScore("Company fails to beat estimates") < 0);
  const items = [{ t: "2026-11-25T10:00:00Z", headline: "X beats, raises outlook" }, { t: "2026-11-25T11:00:00Z", headline: "X upgraded to buy" }];
  const s = newsSentiment(items);
  assert.equal(s.n, 2); assert.match(newsTag(s), /olumlu/);
  assert.equal(newsTag(newsSentiment(items.slice(0, 1))), null);          // tek başlık → etiket yok
  assert.equal(newsSentiment(items, Date.parse("2026-11-26T00:00:00Z")), null);
});
