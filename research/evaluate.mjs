#!/usr/bin/env node
// research/factors.mjs çıktısını değerlendirir. Her kural için: seçilenlerin ortalama KESİTSEL FAZLA getirisi
// (21g), isabet (fazla > 0) ve tarih bazında t-istatistiği. Eğitim / test dönemi ayrı raporlanır — yalnızca
// İKİ dönemde de tutan kural gerçek kabul edilir (aşırı uyum kontrolü).
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.argv[2] || "factors.json", "utf8"));
const SPLIT = process.env.SPLIT || "2025-03-01";
const byDate = new Map();
for (const r of rows) { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r); }

// Tarih içi yüzdelik sıra (0..1) — kesitsel faktörler için
for (const list of byDate.values()) {
  for (const f of ["mom12", "mom6", "ret21", "ret5", "rs60", "hi52", "vol20", "a200", "a50"]) {
    const s = [...list].sort((a, b) => a[f] - b[f]);
    s.forEach((r, i) => { r["p_" + f] = s.length > 1 ? i / (s.length - 1) : 0.5; });
  }
}

// Tarih bazında: o gün seçilenlerin ort. fazla getirisi → tarihler üzerinden ortalama ve t (21g ufuk, haftalık
// adım → ~4 kat örtüşme; t √4 = 2'ye bölünür).
function evalRule(pred, from = "", to = "9999") {
  const per = [];
  let n = 0, hit = 0;
  for (const [d, list] of byDate) {
    if (d < from || d >= to) continue;
    const g = list.filter(pred);
    if (!g.length) continue;
    n += g.length; hit += g.filter(r => r.ex > 0).length;
    per.push(g.reduce((a, r) => a + r.ex, 0) / g.length);
  }
  if (per.length < 5) return null;
  const m = per.reduce((a, b) => a + b, 0) / per.length;
  const sd = Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (per.length - 1));
  return { n, days: per.length, m, hit: hit / n, t: sd ? m / sd * Math.sqrt(per.length) / 2 : 0 };
}
const f = r => r ? `n=${String(r.n).padStart(5)} fazla ${(r.m * 100).toFixed(2).padStart(6)}% isabet ${(r.hit * 100).toFixed(0)}% t ${r.t.toFixed(1).padStart(5)}` : "—".padEnd(44);
export function show(name, pred) {
  console.log(`${name.padEnd(44)} │ EĞİTİM ${f(evalRule(pred, "", SPLIT))} │ TEST ${f(evalRule(pred, SPLIT))}`);
}

const dates = [...byDate.keys()].sort();
console.log(`${rows.length} gözlem · ${dates.length} tarih · ${dates[0]} → ${dates.at(-1)} · eğitim < ${SPLIT} ≤ test\n`);
console.log("── MOTOR (bugünkü canlı kurallar) ──");
show("AL (filtreyi geçen)", r => r.sig === "AL" && r.passed);
show("AL (tüm)", r => r.sig === "AL");
show("SAT (filtreyi geçen) [negatif = doğru]", r => r.sig === "SAT" && r.passed);
show("SAT (tüm) [negatif = doğru]", r => r.sig === "SAT");
show("NÖTR", r => r.sig === "NÖTR");
for (const [lo, hi] of [[60, 75], [75, 90], [90, 101]]) show(`AL güven ${lo}-${hi - 1}`, r => r.sig === "AL" && r.conf >= lo && r.conf < hi);

console.log("\n── FAKTÖR BEŞTE BİRLİKLERİ (tarih içi sıra; Q5 = en yüksek) ──");
for (const fac of ["mom12", "mom6", "ret21", "ret5", "rs60", "hi52", "vol20", "a200", "a50"]) {
  for (const [q, lo, hi] of [["Q1", 0, 0.2], ["Q5", 0.8, 1.01]]) show(`${fac} ${q}`, r => r["p_" + fac] >= lo && r["p_" + fac] < hi);
}

console.log("\n── REJİM ──");
show("SPY > 200g ort. iken AL (filtre)", r => r.spyUp && r.sig === "AL" && r.passed);
show("SPY < 200g ort. iken AL (filtre)", r => !r.spyUp && r.sig === "AL" && r.passed);
show("SPY > 200g iken SAT (filtre)", r => r.spyUp && r.sig === "SAT" && r.passed);
show("SPY < 200g iken SAT (filtre)", r => !r.spyUp && r.sig === "SAT" && r.passed);

if (process.env.EXTRA) {
  const { extra } = await import(process.env.EXTRA);
  extra({ show, rows, byDate });
}
