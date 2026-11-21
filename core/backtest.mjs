// Hafif backtest — geçmiş günlük veride AL sinyali üret → FWD gün sonraki getiriyi ölç.
// Amaç: BIST'ten gelen eşiklerin (MIN_CONF, MIN_ADX) ABD'de işe yarayıp yaramadığını görmek.
// Not: Üst trend için haftalık yerine günlük dilim kullanılır (bist-bot backtest'i ile aynı basitleştirme).
import { enrichData, getHigherTrend, getSignals } from "./engine.mjs";
import { fetchDaily } from "../data/yahoo.mjs";
import ALL from "../spot/symbols.json" with { type: "json" };

const MIN_CONF = +(process.env.MIN_CONF || 65), MIN_ADX = +(process.env.MIN_ADX || 20), FWD = +(process.env.FWD || 10);
const sample = process.env.SYMBOLS ? process.env.SYMBOLS.split(",") : ALL.filter((_, i) => i % 3 === 0);
const spy = await fetchDaily("SPY");
const spyAt = new Map(spy.map((r, i) => [new Date(r.ts).toISOString().slice(0, 10), i]));
const trades = [];

for (let b = 0; b < sample.length; b += 8) {
  await Promise.all(sample.slice(b, b + 8).map(async sym => {
    const all = await fetchDaily(sym);
    if (all.length < 260) return;
    for (let i = 210; i < all.length - FWD; i += 3) {
      const slice = all.slice(0, i + 1), ed = enrichData(slice), last = ed[ed.length - 1];
      if (!last) return;
      const k = getSignals(ed, getHigherTrend(slice), slice);
      if (!k || k.final !== "AL" || k.confidence < MIN_CONF) continue;
      const isDip = !!k.dipSignal;
      if (!isDip && (k.adx || 0) < MIN_ADX) continue;
      if (!isDip && k.higherTrend === "ASAGI") continue;
      const fwd = (all[i + FWD].close - last.close) / last.close * 100;
      const si = spyAt.get(new Date(all[i].ts).toISOString().slice(0, 10));
      const spyFwd = si != null && spy[si + FWD] ? (spy[si + FWD].close - spy[si].close) / spy[si].close * 100 : 0;
      trades.push({ conf: k.confidence, dip: isDip, fwd, excess: fwd - spyFwd });
    }
  }));
}

const wr = a => a.length ? (a.filter(t => t.fwd > 0).length / a.length * 100).toFixed(0) : "-";
const av = (a, f = "fwd") => a.length ? (a.reduce((s, t) => s + t[f], 0) / a.length).toFixed(2) : "-";
console.log(`${sample.length} sembol · ${trades.length} AL sinyali · ${FWD} gün ileri`);
console.log(`GENEL: isabet %${wr(trades)} · ort. getiri %${av(trades)} · SPY'a göre fazla %${av(trades, "excess")}`);
for (const [lo, hi] of [[65, 75], [75, 85], [85, 101]]) {
  const g = trades.filter(t => t.conf >= lo && t.conf < hi);
  console.log(`  güven ${lo}-${hi - 1}: ${g.length} · isabet %${wr(g)} · ort %${av(g)} · fazla %${av(g, "excess")}`);
}
const dips = trades.filter(t => t.dip);
console.log(`  DİP: ${dips.length} · isabet %${wr(dips)} · ort %${av(dips)} · fazla %${av(dips, "excess")}`);
