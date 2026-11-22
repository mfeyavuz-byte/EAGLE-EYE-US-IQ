// KORKU & AÇGÖZLÜLÜK ENDEKSİ — CNN Fear & Greed'in YAYIMLANMIŞ yöntemiyle kendi hesabımız.
// (CNN'in veri uç noktası otomatik istekleri engelliyor [HTTP 418]; engel aşılmaz. Bileşenler ücretsiz ve 2007'den beri var.)
// CNN'in 7 bileşeninden günlük geçmişi ücretsiz olan 4'ü:
//   1) Piyasa momentumu   : S&P 500 (SPY) / 125 günlük ortalama
//   2) Piyasa oynaklığı   : VIX / 50 günlük ortalama (TERS — yüksek VIX = korku)
//   3) Güvenli liman talebi: SPY 20 günlük getirisi − uzun vadeli tahvil (TLT) 20 günlük getirisi
//   4) Riskli tahvil talebi: yüksek getirili tahvil (HYG) 20g getirisi − devlet tahvili (IEF) 20g getirisi
// (Hisse fiyat gücü, piyasa genişliği ve put/call oranı: günlük geçmişi ücretsiz değil → dahil değil.)
// Her bileşen son 252 günlük kendi geçmişine göre yüzdelik sıraya çevrilir (0–100); endeks = ortalama.
// 0–25 AŞIRI KORKU · 25–45 korku · 45–55 nötr · 55–75 açgözlülük · 75–100 AŞIRI AÇGÖZLÜLÜK
export const FG_SYMS = ["SPY", "^VIX", "TLT", "HYG", "IEF"];
const WIN = 252;

const sma = (a, i, n) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; return s / n; };
const pctRank = (arr, i, v) => {                      // v'nin son WIN gözlem içindeki yüzdelik sırası (0..100)
  let n = 0, below = 0;
  for (let j = Math.max(0, i - WIN + 1); j <= i; j++) { if (arr[j] == null) continue; n++; if (arr[j] < v) below++; else if (arr[j] === v) below += 0.5; }
  return n >= 60 ? below / n * 100 : null;
};

// series: { SYM: Map(date → close) } → [{ d, fg, parts:{mom, vol, haven, junk} }] (ortak günler)
export function computeFG(series) {
  const dates = [...series.SPY.keys()].filter(d => FG_SYMS.every(s => series[s]?.has(d))).sort();
  const c = s => dates.map(d => series[s].get(d));
  const spy = c("SPY"), vix = c("^VIX"), tlt = c("TLT"), hyg = c("HYG"), ief = c("IEF");
  const raw = { mom: [], vol: [], haven: [], junk: [] };
  for (let i = 0; i < dates.length; i++) {
    const m125 = sma(spy, i, 125), v50 = sma(vix, i, 50);
    raw.mom.push(m125 ? spy[i] / m125 - 1 : null);
    raw.vol.push(v50 ? -(vix[i] / v50 - 1) : null);                 // ters: VIX ortalamanın üstü = korku
    raw.haven.push(i >= 20 ? (spy[i] / spy[i - 20] - 1) - (tlt[i] / tlt[i - 20] - 1) : null);
    raw.junk.push(i >= 20 ? (hyg[i] / hyg[i - 20] - 1) - (ief[i] / ief[i - 20] - 1) : null);
  }
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const parts = {};
    for (const k of Object.keys(raw)) parts[k] = raw[k][i] == null ? null : pctRank(raw[k], i, raw[k][i]);
    const v = Object.values(parts);
    if (v.some(x => x == null)) continue;
    out.push({ d: dates[i], fg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), parts: Object.fromEntries(Object.entries(parts).map(([k, x]) => [k, Math.round(x)])) });
  }
  return out;
}

export const fgLabel = v => v < 25 ? "AŞIRI KORKU" : v < 45 ? "korku" : v <= 55 ? "nötr" : v <= 75 ? "açgözlülük" : "AŞIRI AÇGÖZLÜLÜK";

// Canlı kullanım: fetchHistory(sym, from) → [{ts, close}] (data/yahoo.mjs) ile son ~2 yıl
export async function loadFG(fetchHistory, nyDate, from = null) {
  const start = from || new Date(Date.now() - 800 * 864e5).toISOString().slice(0, 10);
  const series = {};
  for (const s of FG_SYMS) {
    const rows = await fetchHistory(s, start);
    series[s] = new Map(rows.map(r => [nyDate(new Date(r.ts)), r.close]));
  }
  return computeFG(series);
}
