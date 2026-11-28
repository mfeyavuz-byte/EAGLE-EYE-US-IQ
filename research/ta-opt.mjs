#!/usr/bin/env node
// FORMASYONLARIN GERÇEK OPSİYON FİYATIYLA TESTİ — research/ta.mjs'in canlıya aldığı kalıpların Şubat 2024 sonrası sinyalleri
// (TA_DUMP dosyası) Alpaca'nın geçmiş opsiyon günlük mumlarıyla fiyatlanır. Yalnız ALIM: CALL (yükseliş) / PUT (düşüş).
// Kontrat: canlıdaki gibi ~1 ay+ vade (ayın 3. Cuması, ≥ 35 gün), delta ≈ 0.5 (20 günlük gerçekleşen oynaklıkla).
// Giriş: sinyal günü kapanışı · Çıkış: dayanak stop/hedef gördüğü gün ya da 20 işlem günü (hissedeki kuralla aynı gün).
// Maliyet: alış ve satışta %3 (yarım spread varsayımı) · Sonuç: opsiyon getirisi (%), aynı fikirlerin hisse R'ı ile yan yana.
import { readFileSync } from "node:fs";
import { optionBars, alpacaEnabled } from "../data/alpaca.mjs";
import { pickExpiry, occ, strikeCands } from "../options/backtest.mjs";
import { TA_LABEL, TF_LABEL } from "../bot/ta.mjs";

const F = process.argv[2] || "ta_signals.json", COST = 0.03, MAX = +(process.env.TAOPT_MAX || 700);
if (!alpacaEnabled()) { console.log("SONUÇ\nALPACA anahtarı yok → opsiyon testi yapılamadı."); process.exit(0); }
let sigs = [];
try { sigs = JSON.parse(readFileSync(F, "utf8")); } catch { console.log("SONUÇ\nSinyal dosyası yok (önce TA_DUMP ile research/ta.mjs)."); process.exit(0); }
if (sigs.length > MAX) { const st = sigs.length / MAX; sigs = Array.from({ length: MAX }, (_, k) => sigs[Math.floor(k * st)]); }   // eşit aralıklı örnek
const res = [];
for (const s of sigs) {
  const exp = pickExpiry(s.d);
  if (!exp || !(s.hv > 0)) continue;
  const T = (Date.parse(exp) - Date.parse(s.d)) / 365 / 864e5, Ks = strikeCands(s.dir, s.S, T, s.hv, 0.5, 6);
  const syms = Ks.map(K => occ(s.sym, exp, s.dir, K));
  const end = new Date(Date.parse(s.ed) + 864e5).toISOString().slice(0, 10);
  const bars = await optionBars(syms, s.d, end).catch(() => null);
  if (!bars) continue;
  for (const o of syms) {                                                 // deltaya en yakın, giriş günü fiyatı olan kontrat
    const b = bars[o] || [], e = b.find(x => x.d === s.d), x = [...b].reverse().find(q => q.d <= s.ed && q.d > s.d);
    if (!e || !x || !(e.c > 0)) continue;
    res.push({ ...s, ret: (x.c * (1 - COST)) / (e.c * (1 + COST)) - 1 });
    break;
  }
}
const grp = {};
for (const r of res) (grp[`${r.name}|${r.dir}|${r.tf}`] ||= []).push(r);
const p = x => `${x >= 0 ? "+" : "−"}%${Math.abs(x * 100).toFixed(1)}`;
const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
console.log(`SONUÇ — FORMASYONLAR GERÇEK OPSİYON FİYATIYLA (Alpaca, ${sigs[0]?.d ?? "?"} sonrası · ${res.length}/${sigs.length} fikir fiyatlanabildi · alış+satış %3 maliyet)`);
const L = [];
for (const [k, a] of Object.entries(grp)) {
  const [name, dir, tf] = k.split("|"), m = a.reduce((q, r) => q + r.ret, 0) / a.length, w = a.filter(r => r.ret > 0).length / a.length, mr = a.reduce((q, r) => q + r.r, 0) / a.length;
  console.log(`${(name + " " + dir + " " + tf).padEnd(16)} n ${String(a.length).padStart(4)} · opsiyon ort ${p(m)} · medyan ${p(med(a.map(r => r.ret)))} · kazanan %${Math.round(w * 100)} · aynı fikirler hissede ${mr >= 0 ? "+" : ""}${mr.toFixed(2)}R`);
  L.push(`${m > 0 ? "✅" : "❌"} ${dir === "C" ? "CALL" : "PUT"} — ${TA_LABEL[name]?.[dir] || name}${TF_LABEL[tf] || ""}: opsiyonda ort ${p(m)} · kazanan %${Math.round(w * 100)} (${a.length} fikir)`);
}
console.log(["ÖZET", `🧪 Formasyonlar gerçek opsiyon fiyatıyla (2024 sonrası, %3 maliyet dahil)`, ...(L.length ? L : ["Fiyatlanabilen fikir yok."])].join("\n"));
