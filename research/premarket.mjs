#!/usr/bin/env node
// AÇILIŞ ÖNCESİ GÜNLÜK YÖN ARAŞTIRMASI (SPY, QQQ) — açılıştan önce bilinebilecek bilgiler o günün yönünü tahmin
// ediyor mu? Bilgiler: dünkü kapanışa göre trend (200g), RSI(2), VIX (dünkü seviye ve değişim), açılış boşluğu
// (sabah vadeli işlemlerden yaklaşık bilinir). Hedef: o günün açılış→kapanış getirisi (gün içi işlem).
// Eğitim < 2014 ≤ test. Taban: her gün açılışta al.
import { fetchHistory } from "../data/yahoo.mjs";
import { rsiSeries, smaAt } from "../spot/etfsignal.mjs";

const SPLIT = "2014-01-01";
const iso = ts => new Date(ts).toISOString().slice(0, 10);

export function features(rows, vixMap) {
  const c = rows.map(r => r.close), r2 = rsiSeries(c, 2), out = [];
  for (let i = 201; i < rows.length; i++) {
    const p = i - 1, s200 = smaAt(c, p, 200), s5 = smaAt(c, p, 5);
    const v0 = vixMap.get(rows[p].d), v1 = vixMap.get(rows[p - 1]?.d);
    if (!(rows[i].open > 0)) continue;
    out.push({
      d: rows[i].d, up200: c[p] > s200, above5: c[p] > s5, rsi2: r2[p], gap: rows[i].open / c[p] - 1,
      vix: v0 ?? null, vixChg: v0 && v1 ? v0 / v1 - 1 : null,
      oc: rows[i].close / rows[i].open - 1, hi: rows[i].high / rows[i].open - 1, lo: rows[i].low / rows[i].open - 1,
    });
  }
  return out;
}

export const RULES = [
  ["TABAN: her gün açılışta al", 1, f => true],
  ["Trend yukarı (200g üstü) → al", 1, f => f.up200],
  ["Trend aşağı (200g altı) → sat", -1, f => !f.up200],
  ["RSI2 < 10 & 200g üstü → al", 1, f => f.up200 && f.rsi2 < 10],
  ["RSI2 > 90 & 200g altı → sat", -1, f => !f.up200 && f.rsi2 > 90],
  ["Boşluk ≤ −%0.5 & 200g üstü → al (boşluk dolumu)", 1, f => f.up200 && f.gap <= -0.005],
  ["Boşluk ≥ +%0.5 → sat (boşluk dolumu)", -1, f => f.gap >= 0.005],
  ["Boşluk ≤ −%0.5 (şartsız) → al", 1, f => f.gap <= -0.005],
  ["VIX dün +%10 ↑ & 200g üstü → al", 1, f => f.up200 && f.vixChg != null && f.vixChg >= 0.10],
  ["VIX > 30 → al", 1, f => f.vix != null && f.vix > 30],
  ["VIX < 13 & 200g üstü → al", 1, f => f.up200 && f.vix != null && f.vix < 13],
];

function stat(fs, dir) {
  if (fs.length < 20) return null;
  const r = fs.map(f => dir * f.oc), n = r.length, m = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, hit: r.filter(x => x > 0).length / n, m, t: m / sd * Math.sqrt(n) };
}
const fmt = s => s ? `n=${String(s.n).padStart(4)} isabet ${(s.hit * 100).toFixed(1).padStart(5)}% ort ${(s.m * 1e4).toFixed(1).padStart(5)}bp t ${s.t.toFixed(1).padStart(5)}` : "—".padEnd(40);

async function main() {
  const vix = await fetchHistory("^VIX", "1990-01-01");
  const vixMap = new Map(vix.map(r => [iso(r.ts), r.close]));
  for (const sym of ["SPY", "QQQ"]) {
    const rows = (await fetchHistory(sym, "1990-01-01")).map(r => ({ d: iso(r.ts), open: r.open, high: r.high, low: r.low, close: r.close })).filter(r => r.close > 0);
    const F = features(rows, vixMap);
    console.log(`\n══ ${sym} · ${F[0].d} → ${F.at(-1).d} · açılış→kapanış ══`);
    for (const [name, dir, pred] of RULES) {
      const g = F.filter(pred);
      console.log(`${name.padEnd(46)} │ EĞİTİM ${fmt(stat(g.filter(f => f.d < SPLIT), dir))} │ TEST ${fmt(stat(g.filter(f => f.d >= SPLIT), dir))}`);
    }
  }
}
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
