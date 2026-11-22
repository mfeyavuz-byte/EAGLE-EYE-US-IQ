#!/usr/bin/env node
// KORKU & AÇGÖZLÜLÜK ARAŞTIRMASI — endeks (spot/feargreed.mjs) SPY/QQQ'nun 1 / 5 / 10 günlük getirisini tahmin ediyor mu?
// Giriş: o günün kapanışı (endeks kapanışla hesaplanır) · eğitim 2008–2016 / test 2017–2026 · taban: her gün.
import { fetchHistory } from "../data/yahoo.mjs";
import { nyDate } from "../data/market.mjs";
import { loadFG } from "../spot/feargreed.mjs";
import { smaAt } from "../spot/etfsignal.mjs";

const SPLIT = "2017-01-01";
const BUCKETS = [["Aşırı korku < 25", 0, 25], ["Korku 25–45", 25, 45], ["Nötr 45–55", 45, 55.01], ["Açgözlülük 55–75", 55.01, 75.01], ["Aşırı açgözlülük > 75", 75.01, 101]];

function stat(r) {
  if (r.length < 15) return null;
  const n = r.length, m = r.reduce((a, b) => a + b, 0) / n;
  return { n, hit: r.filter(x => x > 0).length / n, m };
}
const f = s => s ? `n=${String(s.n).padStart(4)} ↑%${(s.hit * 100).toFixed(0).padStart(2)} ort ${(s.m * 100).toFixed(2).padStart(6)}%` : "—".padEnd(25);

const fg = await loadFG(fetchHistory, nyDate, "2007-04-15");
console.log(`Endeks: ${fg[0].d} → ${fg.at(-1).d} · ${fg.length} gün · son değer ${fg.at(-1).fg}`);
const fgMap = new Map(fg.map(x => [x.d, x.fg]));
for (const sym of ["SPY", "QQQ"]) {
  const rows = (await fetchHistory(sym, "2006-01-01")).map(r => ({ d: nyDate(new Date(r.ts)), c: r.close }));
  const c = rows.map(r => r.c);
  console.log(`\n══ ${sym} · eğitim < ${SPLIT} ≤ test ══`);
  for (const H of [1, 5, 10]) {
    console.log(`-- ${H} gün sonra --`);
    const obs = [];
    for (let i = 200; i + H < rows.length; i++) {
      const v = fgMap.get(rows[i].d);
      if (v == null) continue;
      obs.push({ d: rows[i].d, v, up200: c[i] > smaAt(c, i, 200), r: c[i + H] / c[i] - 1 });
    }
    const line = (lab, p) => {
      const g = obs.filter(p);
      console.log(`${lab.padEnd(36)} │ EĞİTİM ${f(stat(g.filter(o => o.d < SPLIT).map(o => o.r)))} │ TEST ${f(stat(g.filter(o => o.d >= SPLIT).map(o => o.r)))}`);
    };
    line("TABAN (her gün)", () => true);
    for (const [lab, lo, hi] of BUCKETS) line(lab, o => o.v >= lo && o.v < hi);
    line("Aşırı korku & 200g üstü", o => o.v < 25 && o.up200);
    line("Aşırı korku & 200g altı", o => o.v < 25 && !o.up200);
    line("Aşırı açgözlülük & 200g altı", o => o.v > 75 && !o.up200);
  }
}
