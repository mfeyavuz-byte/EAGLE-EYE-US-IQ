#!/usr/bin/env node
// ETF OPSİYON GERİYE DÖNÜK TESTİ — SPY/QQQ kısa vade sinyali (spot/etfsignal.mjs) → CALL ALIMI → gerçek geçmiş
// opsiyon kapanışları (Alpaca, Şubat 2024+). Hangi vade ve delta en iyi? Varyantlar aynı sinyallerde karşılaştırılır.
// Giriş: sinyal günü kapanışı · çıkış: dayanak 5g ortalamanın üstünde kapanınca ya da en çok 10 işlem günü.
// Maliyet: geçmiş kotasyon yok → giriş+çıkışta fiyatın %0 / %1 / %3'ü (SPY/QQQ ATM spread'i tipik ~%0.5–1).
// Çalıştırma: ALPACA_KEY_ID=… ALPACA_SECRET_KEY=… node options/etf-backtest.mjs   (ETF_START=2024-03-01)
import { fetchHistory } from "../data/yahoo.mjs";
import { alpacaEnabled, optionBars } from "../data/alpaca.mjs";
import { occ, strikeCands, summarize } from "./backtest.mjs";
import { hvC2C } from "./vol.mjs";
import { etfState, ETF_CFG, ETFS_FAST } from "../spot/etfsignal.mjs";

const START = process.env.ETF_START || "2024-03-01";
const iso = ts => new Date(ts).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const COSTS = [0, 0.01, 0.03];

// İlk Cuma (haftalık vade) ≥ minDte gün sonra
export function fridayAfter(d, minDte) {
  let t = Date.parse(d + "T00:00:00Z") + minDte * 864e5;
  while (new Date(t).getUTCDay() !== 5) t += 864e5;
  return iso(t);
}

// Sinyaller: { sym, i, d, exitD, tier, S }
export function signals(rows, from) {
  const c = rows.map(r => r.close), out = [];
  for (let i = 201; i < c.length - 1; i++) {
    if (rows[i].d < from) continue;
    const s = etfState(c.slice(0, i + 1));
    if (!s?.tier) continue;
    let j = i + 1;
    while (j < c.length - 1 && j - i < ETF_CFG.MAXD && !etfState(c.slice(0, j + 1)).exit) j++;
    out.push({ i, d: rows[i].d, exitD: rows[j].d, days: j - i, tier: s.tier, S: c[i], und: c[j] / c[i] - 1 });
    i = j;
  }
  return out;
}

async function main() {
  if (!alpacaEnabled()) { console.error("ALPACA anahtarları gerekli."); process.exit(2); }
  const VARS = [];
  for (const dte of [14, 30, 60]) for (const delta of [0.5, 0.7]) VARS.push({ dte, delta, name: `vade ≥${dte}g · delta ${delta}` });
  const res = Object.fromEntries(VARS.map(v => [v.name, []]));
  const allSig = [];
  for (const sym of ETFS_FAST) {
    const rows = (await fetchHistory(sym, "2022-06-01")).map(r => ({ d: iso(r.ts), close: r.close }));
    const sig = signals(rows, START);
    console.log(`${sym}: ${sig.length} sinyal (güçlü ${sig.filter(s => s.tier === "güçlü").length}) · dayanak isabet %${Math.round(sig.filter(s => s.und > 0).length / Math.max(1, sig.length) * 100)}`);
    for (const s of sig) {
      allSig.push({ sym, ...s });
      const hv = Math.max(0.1, hvC2C(rows.slice(0, s.i + 1), 20) || 0.2);
      for (const v of VARS) {
        const exp = fridayAfter(s.d, v.dte), T = dayDiff(s.d, exp) / 365;
        const Ks = strikeCands("C", s.S, T, hv, v.delta, 6, [1]);
        const syms = Ks.map(K => occ(sym, exp, "C", K));
        const bars = await optionBars(syms, s.d, s.exitD < exp ? s.exitD : exp);
        if (!bars) continue;
        for (const o of syms) {
          const b = bars[o];
          const e = b?.find(x => x.d === s.d && x.c > 0);
          if (!e) continue;
          const x = b.filter(x => x.d <= s.exitD && x.d > s.d).pop();   // çıkış günü (yoksa öncesindeki son kapanış)
          if (!x) continue;
          res[v.name].push({ sym, tier: s.tier, entry: { d: e.d, c: e.c }, exit: { d: x.d, c: x.c }, und: s.und });
          break;
        }
      }
    }
  }
  console.log("\n" + report(res, allSig));
}

const pc = v => (v * 100).toFixed(1) + "%";
const usd = v => (v >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US");
const line = (lab, s) => s ? `${lab.padEnd(28)} n=${String(s.n).padStart(3)} · kazanan ${pc(s.winRate).padStart(6)} · ort ${pc(s.avgRet).padStart(7)} · medyan ${pc(s.medRet).padStart(7)} · K/Z ${usd(s.pnl).padStart(8)} · prim getirisi ${pc(s.roi).padStart(7)} · PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)} · ${s.days.toFixed(1)}g` : `${lab.padEnd(28)} —`;

export function report(res, allSig) {
  const L = [];
  const n = allSig.length, hit = allSig.filter(s => s.und > 0).length;
  L.push(`SONUÇ — SPY/QQQ kısa vade sinyali → CALL alımı · ${n} sinyal · dayanak isabet %${Math.round(hit / Math.max(1, n) * 100)} · ort dayanak ${pc(allSig.reduce((a, s) => a + s.und, 0) / Math.max(1, n))}`);
  for (const c of COSTS) {
    L.push("", `── Maliyet: giriş+çıkışta %${(c * 100).toFixed(0)} ──`);
    for (const [name, legs] of Object.entries(res)) L.push(line(name, summarize(legs, c)));
  }
  L.push("", "── Sinyal gücüne göre (maliyet %1) ──");
  for (const [name, legs] of Object.entries(res)) {
    for (const t of ["güçlü", "normal"]) L.push(line(`${name} · ${t}`, summarize(legs.filter(l => l.tier === t), 0.01)));
  }
  L.push("", "── ETF'e göre (maliyet %1) ──");
  for (const [name, legs] of Object.entries(res)) for (const s of ETFS_FAST) L.push(line(`${name} · ${s}`, summarize(legs.filter(l => l.sym === s), 0.01)));
  return L.join("\n");
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error("FATAL", e); process.exit(1); });
