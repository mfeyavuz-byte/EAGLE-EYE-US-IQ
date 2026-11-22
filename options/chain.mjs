// Opsiyon zincirini yükle ve zenginleştir: her kontrat için kendi IV'miz (orta fiyattan), delta, Greek'ler,
// spread yüzdesi, likidite bayrağı. Yahoo'nun hazır IV alanı illikit strike'larda güvenilmez → kullanmıyoruz.
import { optionChain } from "../data/yahoo.mjs";
import { bs, impliedVol } from "./bs.mjs";

export const LIQ = {
  MIN_OI: +(process.env.OPT_MIN_OI || 100),          // bacak başına en az açık pozisyon
  MAX_SPREAD: +(process.env.OPT_MAX_SPREAD || 0.12), // (ask−bid)/orta ≤ %12
  MIN_BID: 0.05,
};

function enrich(list, type, S, T, r, q) {
  return list.map(o => {
    const mid = o.bid > 0 && o.ask > 0 && o.ask >= o.bid ? (o.bid + o.ask) / 2 : null;
    const iv = mid ? impliedVol(type, mid, S, o.strike, T, r, q) : null;
    const g = iv ? bs(type, S, o.strike, T, r, q, iv) : null;
    const spreadPct = mid ? (o.ask - o.bid) / mid : 1;
    return {
      ...o, type, K: o.strike, mid, iv, spreadPct,
      delta: g?.delta ?? null, gamma: g?.gamma ?? null, vega: g?.vega ?? null, theta: g?.theta ?? null,
      liquid: !!(mid && iv && o.bid >= LIQ.MIN_BID && o.oi >= LIQ.MIN_OI && spreadPct <= LIQ.MAX_SPREAD),
    };
  }).filter(o => o.mid != null).sort((a, b) => a.K - b.K);
}

// Hangi vadeler yüklenecek: ön (≥7g, analiz), işlem penceresi [minDte,maxDte] (en çok 3), arka (60–120g, vade yapısı).
// targets verilirse pencereden her hedef güne en yakın vade seçilir (yayılım: kısa/orta/uzun).
export function pickExpiries(exps, nowSec, { minDte = 21, maxDte = 60, analyticsOnly = false, targets = null } = {}) {
  // Varsayılan: 5 günden kısa vadeler atlanır. minDte < 5 istenirse (0DTE/1DTE) bugünün vadesi de dahil edilir
  // (Yahoo vade damgası 00:00 UTC → seans içinde dte negatif görünür; −0.75 güne kadar kabul).
  const lo = minDte < 5 ? Math.max(-0.75, minDte - 0.75) : 5;
  const withDte = exps.map(e => ({ e, dte: (e - nowSec) / 86400 })).filter(x => x.dte >= lo);
  const pick = new Set();
  const front = withDte.find(x => x.dte >= 7);
  if (front) pick.add(front.e);
  const near30 = withDte.slice().sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))[0];
  if (near30) pick.add(near30.e);
  if (!analyticsOnly) {
    const win = withDte.filter(x => x.dte >= minDte && x.dte <= maxDte);
    // pencereden en çok 3 vade: 38 güne en yakın + yayılım
    if (targets) for (const t of targets) { const b = win.slice().sort((a, c) => Math.abs(a.dte - t) - Math.abs(c.dte - t))[0]; if (b) pick.add(b.e); }
    else win.sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38)).slice(0, 3).forEach(x => pick.add(x.e));
    const back = withDte.find(x => x.dte >= 60 && x.dte <= 130);
    if (back) pick.add(back.e);
  }
  return [...pick].sort((a, b) => a - b);
}

// PARİTE SPOTU: C − P = e^{−rT}(F − K) → F = K + (C − P)·e^{rT}, S = F·e^{−(r−q)T}.
// Kotasyondaki hisse fiyatı ile opsiyon kotasyonları farklı anlarda alınmış olabilir (opsiyonlar 16:15'e dek
// işlem görür, veri gecikmeli olabilir). Uyuşmazlık IV'yi ve olasılıkları bozar → dayanak fiyatını ZİNCİRDEN çıkarırız.
export function paritySpot(raw, S, r, q) {
  const est = [];
  for (const { T, calls, puts } of raw) {
    const mid = o => (o.bid > 0 && o.ask >= o.bid ? (o.bid + o.ask) / 2 : null);
    const pairs = calls.map(c => [c, puts.find(p => p.strike === c.strike)])
      .filter(([c, p]) => p && mid(c) && mid(p))
      .sort((a, b) => Math.abs(a[0].strike - S) - Math.abs(b[0].strike - S)).slice(0, 3);
    for (const [c, p] of pairs) est.push((c.strike + (mid(c) - mid(p)) * Math.exp(r * T)) * Math.exp(-(r - q) * T));
  }
  if (est.length < 3) return null;
  est.sort((a, b) => a - b);
  const med = est[Math.floor(est.length / 2)];
  return Math.abs(med / S - 1) < 0.05 ? med : null;                     // %5'ten büyük fark = bozuk veri, kullanma
}

// Dönüş: { sym, S, Squote, parityGap, q, r, earningsTs, expiries:[{exp, dte, T, calls, puts}] } | null
export async function loadChain(sym, r, opts = {}) {
  const first = await optionChain(sym);
  if (!first || !first.quote.price || !first.expirations.length) return null;
  const Squote = first.quote.price, q = Math.min(0.15, Math.max(0, first.quote.divYield || 0));
  const nowSec = Date.now() / 1e3;
  const wanted = pickExpiries(first.expirations, nowSec, opts);
  const raw = [];
  for (const exp of wanted) {
    const ch = exp === first.exp ? first : await optionChain(sym, exp);
    if (!ch) continue;
    // Yahoo vade damgası 00:00 UTC; opsiyon 16:00 NY'de sona erer → +20 saat
    const T = Math.max(1 / 365, (exp + 20 * 3600 - nowSec) / (365 * 86400));
    raw.push({ exp, T, calls: ch.calls, puts: ch.puts });
  }
  const Sp = paritySpot(raw, Squote, r, q);
  const S = Sp ?? Squote;
  const expiries = raw.map(({ exp, T, calls, puts }) => ({ exp, dte: Math.round(T * 365), T, calls: enrich(calls, "C", S, T, r, q), puts: enrich(puts, "P", S, T, r, q) }));
  return { sym, S, Squote, parityGap: Sp ? Sp / Squote - 1 : 0, q, r, earningsTs: first.quote.earningsTs, expiries };
}
