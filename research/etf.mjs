#!/usr/bin/env node
// ETF ZAMANLAMA ARAŞTIRMASI — SPY ve QQQ için kısa vadeli, yüksek isabetli GİRİŞ kuralları (yalnız ALIM yönü
// ve karşılaştırma için kısa yön). Uzun geçmiş (Yahoo, ~1993/1999'dan bugüne) → iki ayrı dönemde (eğitim/test).
// Her kural: giriş = sinyal günü kapanışı · çıkış = kuralın çıkış koşulu (kapanışta) ya da en çok MAXD işlem günü.
// Ölçü: işlem sayısı, isabet (getiri > 0), ort. getiri, ort. süre, günlük ortalama getiri, en kötü %5.
// TABAN: aynı dönemde rastgele bir günde girip aynı ortalama süre tutmak (piyasanın genel yükselişi).
import { fetchHistory } from "../data/yahoo.mjs";

const SPLIT = process.env.SPLIT || "2014-01-01";
const SYMS = (process.env.ETF || "SPY,QQQ").split(",");

const sma = (c, i, n) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; };
function rsi(c, n) {                                   // Wilder RSI dizisi
  const out = new Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l ? 100 - 100 / (1 + g / l) : 100; continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l ? 100 - 100 / (1 + g / l) : 100;
  }
  return out;
}
const sd = (c, i, n) => { const m = sma(c, i, n); let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - m) ** 2; return Math.sqrt(s / n); };

// KURALLAR: entry(i) → bool · exit(i, e) → bool (e: giriş indeksi) · dir: +1 alım, −1 düşüş yönü
export function rules(c, MAXD = 10) {
  const r2 = rsi(c, 2), r14 = rsi(c, 14);
  const up200 = i => sma(c, i, 200) != null && c[i] > sma(c, i, 200);
  const aboveS5 = i => c[i] > sma(c, i, 5);
  const downDays = (i, k) => { for (let j = 0; j < k; j++) if (!(c[i - j] < c[i - j - 1])) return false; return true; };
  return [
    { name: "RSI2<10 & 200g üstü → 5g ort. üstü çık", dir: 1, entry: i => up200(i) && r2[i] < 10, exit: (i) => aboveS5(i) },
    { name: "RSI2<5 & 200g üstü → 5g ort. üstü çık", dir: 1, entry: i => up200(i) && r2[i] < 5, exit: (i) => aboveS5(i) },
    { name: "3 gün üst üste düşüş & 200g üstü → 5g üstü", dir: 1, entry: i => up200(i) && downDays(i, 3), exit: (i) => aboveS5(i) },
    { name: "Alt Bollinger(20,2) & 200g üstü → 20g ort.", dir: 1, entry: i => up200(i) && c[i] < sma(c, i, 20) - 2 * sd(c, i, 20), exit: (i) => c[i] > sma(c, i, 20) },
    { name: "RSI2<10 (200g şartsız) → 5g üstü", dir: 1, entry: i => r2[i] < 10, exit: (i) => aboveS5(i) },
    { name: "RSI14<30 & 200g üstü → RSI14>50", dir: 1, entry: i => up200(i) && r14[i] < 30, exit: (i) => r14[i] > 50 },
    { name: "[düşüş] RSI2>90 & 200g altı → 5g altı", dir: -1, entry: i => !up200(i) && r2[i] > 90, exit: (i) => c[i] < sma(c, i, 5) },
    { name: "[düşüş] RSI2>95 (şartsız) → 5g altı", dir: -1, entry: i => r2[i] > 95, exit: (i) => c[i] < sma(c, i, 5) },
  ].map(x => ({ ...x, MAXD }));
}

// Bir kuralın işlemleri (çakışmasız: açık işlem varken yeni giriş yok)
export function trades(rows, rule) {
  const c = rows.map(r => r.close), out = [];
  for (let i = 201; i < c.length - 1; i++) {
    if (!rule.entry(i)) continue;
    let j = i + 1;
    while (j < c.length - 1 && j - i < rule.MAXD && !rule.exit(j)) j++;
    out.push({ d: rows[i].d, days: j - i, ret: rule.dir * (c[j] / c[i] - 1) });
    i = j;
  }
  return out;
}

function stat(t) {
  if (!t.length) return null;
  const r = t.map(x => x.ret).sort((a, b) => a - b), n = r.length, m = r.reduce((a, b) => a + b, 0) / n;
  const days = t.reduce((a, x) => a + x.days, 0) / n, k = Math.max(1, Math.floor(n * 0.05));
  return { n, hit: t.filter(x => x.ret > 0).length / n, m, days, perDay: m / days, w5: r.slice(0, k).reduce((a, b) => a + b, 0) / k };
}
const f = s => s ? `n=${String(s.n).padStart(4)} isabet ${(s.hit * 100).toFixed(0).padStart(3)}% ort ${(s.m * 100).toFixed(2).padStart(6)}% · ${s.days.toFixed(1)}g · günlük ${(s.perDay * 1e4).toFixed(1).padStart(5)}bp · en kötü%5 ${(s.w5 * 100).toFixed(1)}%` : "—";

async function main() {
  for (const sym of SYMS) {
    const rows = (await fetchHistory(sym, "1990-01-01")).map(r => ({ d: new Date(r.ts).toISOString().slice(0, 10), close: r.close })).filter(r => r.close > 0);
    const c = rows.map(r => r.close);
    console.log(`\n══ ${sym} · ${rows[0].d} → ${rows.at(-1).d} · ${rows.length} gün · eğitim < ${SPLIT} ≤ test ══`);
    // Taban: her gün gir, H gün tut (H = 4)
    const base = H => { const t = []; for (let i = 201; i + H < c.length; i++) t.push({ d: rows[i].d, days: H, ret: c[i + H] / c[i] - 1 }); return t; };
    const b = base(4);
    console.log(`${"TABAN: her gün al, 4 gün tut".padEnd(46)} │ EĞİTİM ${f(stat(b.filter(x => x.d < SPLIT)))}\n${"".padEnd(46)} │ TEST   ${f(stat(b.filter(x => x.d >= SPLIT)))}`);
    for (const rule of rules(c)) {
      const t = trades(rows, rule);
      console.log(`${rule.name.padEnd(46)} │ EĞİTİM ${f(stat(t.filter(x => x.d < SPLIT)))}\n${"".padEnd(46)} │ TEST   ${f(stat(t.filter(x => x.d >= SPLIT)))}`);
    }
  }
}
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
