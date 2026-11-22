// DEĞER ("UCUZ HİSSE") MODEL PORTFÖYÜ — kazancına, defterine, nakit akışına göre UCUZ ama KÂRLI ve borcu makul hisseler.
// ⚠ Geçmiş temel veriler ücretsiz değil → bu kol GERİYE DÖNÜK TEST EDİLEMEDİ; canlı karnesiyle (SPY'a göre) ölçülür.
// Evren: S&P 500 + piyasa değeri ≥ $10 milyar Nasdaq hisseleri, fiyat ≥ $10.
// Kalite kapıları (değer tuzağına karşı): izleyen EPS > 0 · kâr marjı > %5 · özsermaye kârlılığı > %8 ·
//   borç/özsermaye < 200 · serbest nakit akışı > 0 · bot SAT seçimi değil · 52 haftalık zirvenin ≥ %60'ı (çöken hisse yok).
// Ucuzluk puanı (yüksek = ucuz): kazanç verimi (1/FK), ileri kazanç verimi (1/ileri FK), defter verimi (1/PDDD),
//   FAVÖK verimi (1/FD-FAVÖK), serbest nakit akışı verimi (FCF/piyasa değeri) — her biri evren içinde yüzdelik; ortalama.
// Portföy: en ucuz 10 (sektör başına en çok 2), eşit ağırlık, $100.000; AYLIK yeniden dengeleme (yeni ayın ilk işlem günü):
//   listeden düşen satılır, yeni girenler alınır. Her işlemde %0.05 maliyet. Günlük özsermaye + SPY kaydı.
export const VCFG = { CAP: +(process.env.VALUE_CAPITAL || 100000), N: 10, SEC_MAX: 2, COST: 0.0005, MIN_MCAP_NQ: 10e9 };

const okNum = (x, lo, hi) => x != null && isFinite(x) && x > lo && x < hi;

// rows: [{ sym, sec, price, pe, fpe, pb, eps, mcap, q: {margin, roe, de, fcf, evEbitda}, hi52, pick }]
export function rankValue(rows) {
  const passed = rows.filter(r => r.price >= 10 && r.eps > 0 && r.q && r.q.margin > 0.05 && r.q.roe > 0.08 &&
    (r.q.de == null || r.q.de < 200) && r.q.fcf > 0 && r.pick !== "SAT" && (r.hi52 == null || r.hi52 >= 0.6));
  const facs = {
    ey: r => (okNum(r.pe, 0, 200) ? 1 / r.pe : null),
    fey: r => (okNum(r.fpe, 0, 200) ? 1 / r.fpe : null),
    by: r => (okNum(r.pb, 0.1, 100) ? 1 / r.pb : null),                     // PD/DD < 0.1 = veri hatası (ör. BRK.B)
    eby: r => (okNum(r.q.evEbitda, 0, 200) ? 1 / r.q.evEbitda : null),
    fcy: r => (r.mcap > 0 ? r.q.fcf / r.mcap : null),
  };
  for (const [k, f] of Object.entries(facs)) {
    const vals = passed.map(r => ({ r, v: f(r) })).filter(x => x.v != null).sort((a, b) => a.v - b.v);
    // Eşit değerlere eşit (ortalama) sıra — yoksa sıralama listedeki konuma göre bozulur
    for (let i = 0; i < vals.length;) {
      let j = i; while (j + 1 < vals.length && vals[j + 1].v === vals[i].v) j++;
      const pct = vals.length > 1 ? ((i + j) / 2) / (vals.length - 1) : 0.5;
      for (let t = i; t <= j; t++) (vals[t].r.pct ||= {})[k] = pct;
      i = j + 1;
    }
  }
  for (const r of passed) {
    const p = Object.values(r.pct || {});
    r.score = p.length >= 3 ? p.reduce((a, b) => a + b, 0) / p.length : null;          // en az 3 ölçü şart
  }
  return passed.filter(r => r.score != null).sort((a, b) => b.score - a.score);
}

export function pickValue(ranked, n = VCFG.N, secMax = VCFG.SEC_MAX) {
  const out = [], sec = {};
  for (const r of ranked) {
    const s = r.sec || "?";
    if ((sec[s] || 0) >= secMax) continue;
    out.push(r); sec[s] = (sec[s] || 0) + 1;
    if (out.length >= n) break;
  }
  return out;
}

export function initValue(today, spyPx) {
  return { start: { d: today, eq: VCFG.CAP, spy: spyPx ?? null }, cash: VCFG.CAP, pos: {}, closed: [], hist: [], lastRebal: null, list: [] };
}
export const valueEquity = (v, priceOf) => v.cash + Object.entries(v.pos).reduce((a, [s, p]) => a + p.sh * (priceOf(s) ?? p.last ?? p.px), 0);

// Yeniden dengeleme: picks = [{sym, price, score, pe, fpe, pb}] · Dönüş: { bought, sold }
export function rebalanceValue(v, today, picks, priceOf) {
  const keep = new Set(picks.map(p => p.sym)), sold = [], bought = [];
  for (const [s, p] of Object.entries(v.pos)) {
    if (keep.has(s)) continue;
    const px = priceOf(s) ?? p.last ?? p.px, proceeds = p.sh * px * (1 - VCFG.COST);
    v.cash += proceeds;
    const rec = { sym: s, d: p.d, exitD: today, px: p.px, exitPx: px, ret: +(proceeds / p.cost - 1).toFixed(4), pnl: Math.round(proceeds - p.cost), why: "listeden çıktı" };
    v.closed.push(rec); sold.push(rec); delete v.pos[s];
  }
  if (v.closed.length > 300) v.closed.splice(0, v.closed.length - 300);
  const target = valueEquity(v, priceOf) / Math.max(1, picks.length);   // seçilen sayıya eşit ağırlık (tam yatırım)
  for (const p of picks) {
    if (v.pos[p.sym] || !(p.price > 0)) continue;
    const alloc = Math.min(target, v.cash);
    if (alloc < 100) break;
    v.cash -= alloc;
    v.pos[p.sym] = { d: today, px: p.price, sh: alloc * (1 - VCFG.COST) / p.price, cost: alloc, last: p.price };
    bought.push({ sym: p.sym, px: p.price, alloc: Math.round(alloc), pe: p.pe, fpe: p.fpe, pb: p.pb });
  }
  v.lastRebal = today; v.list = picks.map(p => p.sym);
  return { bought, sold };
}

export function snapValue(v, today, priceOf, spyPx) {
  for (const [s, p] of Object.entries(v.pos)) { const px = priceOf(s); if (px > 0) p.last = px; }
  const last = v.hist.at(-1), snap = { d: today, eq: Math.round(valueEquity(v, priceOf)), spy: spyPx ?? last?.spy ?? null };
  if (last?.d === today) v.hist[v.hist.length - 1] = snap; else v.hist.push(snap);
  if (v.hist.length > 800) v.hist.splice(0, v.hist.length - 800);
}

const pc = x => (x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%");
const f1 = x => (x == null || !isFinite(x) ? "—" : x.toFixed(1));
export function fmtValueTrades(bought, sold) {
  const L = ["💎 DEĞER (UCUZ HİSSE) PORTFÖYÜ — aylık yeniden dengeleme"];
  for (const b of bought) L.push(`🟢 ALINDI ${b.sym} $${b.px} (~$${b.alloc.toLocaleString("en-US")}) · F/K ${f1(b.pe)} · ileri F/K ${f1(b.fpe)} · PD/DD ${f1(b.pb)}`);
  for (const s of sold) L.push(`${s.ret >= 0 ? "✅" : "❌"} SATILDI ${s.sym} · ${s.why} · ${(s.ret * 100).toFixed(1)}% ($${s.pnl})`);
  if (!bought.length && !sold.length) L.push("Liste değişmedi.");
  return L.join("\n");
}
// periodStats (bot/model.mjs) ile aynı yapı → dönem getirisi/SPY/düşüş oradan
export function fmtValue(v, stats, title) {
  if (!v) return `${title}\nDeğer portföyü ilk tam taramada kurulur.`;
  const L = [title];
  if (stats) L.push(`Dönem ${stats.from} → ${stats.to} · getiri ${pc(stats.ret)} · SPY ${pc(stats.spyRet)} · fark ${stats.spyRet != null ? pc(stats.ret - stats.spyRet) : "—"} · en büyük düşüş ${stats.mdd < 0 ? pc(stats.mdd) : "%0.00"}`);
  L.push(`Özsermaye $${Math.round(stats?.eq ?? VCFG.CAP).toLocaleString("en-US")} · son dengeleme ${v.lastRebal || "—"} · liste: ${v.list.join(", ") || "—"}`);
  L.push("ℹ Ucuz + kârlı + borcu makul hisseler, eşit ağırlık, aylık dengeleme. Geriye dönük test edilemedi (geçmiş temel veri ücretsiz değil) → canlı karne. ⚠ Yatırım tavsiyesi değildir.");
  return L.join("\n");
}
