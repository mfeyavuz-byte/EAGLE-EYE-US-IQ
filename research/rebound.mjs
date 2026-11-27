#!/usr/bin/env node
// AŞIRI SATIM → HIZLI DÖNÜŞ ARAŞTIRMASI (günlük, 2015 sonrası, en likit büyük hisseler, Yahoo düzeltilmiş kapanış değil ham kapanış).
// Giriş: sinyal günü kapanışı · Çıkış: kapanış 5 günlük ortalamanın üstüne çıkınca ya da en çok 10 işlem günü (zaman çıkışı).
// Kıyas: aynı hisselerde rastgele gün girişinin aynı tutma süresindeki ortalama getirisi.
import { fetchHistory } from "../data/yahoo.mjs";
import { loadUniverse } from "../spot/scan.mjs";
import { reboundSignal, REB } from "../bot/rebound.mjs";

const N = +(process.env.REB_N || 120);
const U = loadUniverse();
const syms = Object.entries(U.meta).filter(([, m]) => m?.dv > 0 && m.idx === "SP500").sort((a, b) => b[1].dv - a[1].dv).slice(0, N).map(([s]) => s);
const VARIANTS = {
  "RSI2<5 · 200g üstü": { rsi2: 5, deep: null, need200: true },
  "RSI2<5 · 200g üstü · 20g ort −2ATR": { rsi2: 5, deep: 2, need200: true },
  "RSI2<2 · 200g üstü": { rsi2: 2, deep: null, need200: true },
  "RSI2<5 · 200g ŞARTI YOK": { rsi2: 5, deep: null, need200: false },
  "RSI2<5 · 200g üstü · 3 gün düşüş": { rsi2: 5, deep: null, need200: true, down3: true },
};
const res = Object.fromEntries(Object.keys(VARIANTS).map(k => [k, []])), base = [];
for (const s of syms) {
  const rows = await fetchHistory(s, "2015-01-01").catch(() => []);
  if (rows.length < 300) continue;
  const c = rows.map(r => r.close);
  for (let i = 220; i < rows.length - 11; i++) {
    const exitAt = k => { for (let j = k + 1; j <= Math.min(rows.length - 1, k + REB.MAX_HOLD); j++) { const s5 = c.slice(j - 4, j + 1).reduce((a, b) => a + b, 0) / 5; if (c[j] > s5) return j; } return Math.min(rows.length - 1, k + REB.MAX_HOLD); };
    if (i % 7 === 0) { const j = exitAt(i); base.push({ r: c[j] / c[i] - 1, d: j - i }); }
    for (const [k, v] of Object.entries(VARIANTS)) {
      if (!reboundSignal(rows.slice(0, i + 1), v)) continue;
      const j = exitAt(i);
      res[k].push({ r: c[j] / c[i] - 1, d: j - i });
      i += 0;                                                        // aynı gün birden çok varyant ayrı sayılır
    }
  }
}
const st = xs => { const n = xs.length, m = n ? xs.reduce((a, x) => a + x.r, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x.r - m) ** 2, 0) / (n - 1)) : 0;
  return `n ${n} · ort %${(m * 100).toFixed(2)} · kazanan %${n ? Math.round(xs.filter(x => x.r > 0).length / n * 100) : 0} · ort ${n ? (xs.reduce((a, x) => a + x.d, 0) / n).toFixed(1) : 0} gün · t ${sd > 0 ? (m / (sd / Math.sqrt(n))).toFixed(1) : "—"}`; };
console.log(`SONUÇ — AŞIRI SATIM DÖNÜŞÜ (${syms.length} likit S&P 500 hissesi, 2015 sonrası, çıkış: 5g ort. üstü ya da ${REB.MAX_HOLD} gün)`);
console.log(`Kıyas (rastgele gün): ${st(base)}`);
for (const [k, xs] of Object.entries(res)) console.log(`${k.padEnd(36)} ${st(xs)}`);
