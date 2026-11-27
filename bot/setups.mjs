// GÜN İÇİ KURULUMLAR (5 dk mum) — araştırma (research/intraday.mjs) ve canlı bot AYNI kodu kullanır.
// Her kurulum yalnız o ana kadarki mumlarla karar verir (ileriye bakma yok). Dönüş: { name, dir: "C"|"P", stop }.
//   PULLBACK  : trend günü geri çekilmesi — son 1 saatin çoğu VWAP'ın aynı tarafında, EMA9/21 trend yönünde, önceki mum
//               EMA21/VWAP'a değdi, bu mum önceki mumun tepesini (dibini) aştı → trend yönünde.
//   RECLAIM   : VWAP geri alma/kaybetme — ≥ 30 dk VWAP'ın bir tarafında kaldıktan sonra diğer tarafta kapanış + genişlik onayı.
//   FLUSH     : açılış düşüşünü sindirme (ve tersi) — ilk 60 dk'da açılışın ≥ %0.4 altına inip açılış fiyatını geri alma
//               (11:30'a kadar) → yükseliş; açılış yükselişinin silinmesi → düşüş.
//   BREADTH   : genişlik itkisi — 11 sektör ETF'inin VWAP üstündeki oranı 30 dk içinde ≤ 0.3'ten ≥ 0.8'e (ya da tersi).
export const SETUP_NAMES = ["PULLBACK", "RECLAIM", "FLUSH", "BREADTH"];

// Günün 5 dk mumlarından göstergeler (dizi): vwap, ema9, ema21, atr(12)
export function dayFeatures(bars) {
  const n = bars.length, vwap = [], e9 = [], e21 = [], atr = [];
  let pv = 0, v = 0, a9 = null, a21 = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i], w = b.volume || 1, tp = (b.high + b.low + b.close) / 3;
    pv += tp * w; v += w; vwap.push(pv / v);
    a9 = a9 == null ? b.close : b.close * (2 / 10) + a9 * (8 / 10); e9.push(a9);
    a21 = a21 == null ? b.close : b.close * (2 / 22) + a21 * (20 / 22); e21.push(a21);
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
    const k = Math.min(12, i + 1);
    atr.push(i ? (atr[i - 1] * (k - 1) + tr) / k : tr);
  }
  return { vwap, e9, e21, atr, open: bars[0]?.open };
}

// i: değerlendirilen (kapanmış) mum · mins: o mumun KAPANIŞ dakikası (NY) · br: genişlik dizisi (0..1, aynı indeks) | null
export function setupsAt(bars, f, i, mins, br = null) {
  const out = [], b = bars[i], p = bars[i - 1];
  if (i < 6 || !p) return out;
  const { vwap, e9, e21, atr, open } = f, A = atr[i];
  const lowN = k => Math.min(...bars.slice(Math.max(0, i - k + 1), i + 1).map(x => x.low));
  const highN = k => Math.max(...bars.slice(Math.max(0, i - k + 1), i + 1).map(x => x.high));

  // PULLBACK
  if (i >= 12 && mins <= 930) {
    const above = bars.slice(i - 12, i).filter((x, k) => x.close > vwap[i - 12 + k]).length;
    const touchL = p.low <= Math.max(e21[i - 1], vwap[i - 1]) + 0.1 * A, touchH = p.high >= Math.min(e21[i - 1], vwap[i - 1]) - 0.1 * A;
    if (above >= 9 && e9[i] > e21[i] && touchL && b.close > p.high && b.close > vwap[i]) out.push({ name: "PULLBACK", dir: "C", stop: lowN(3) - 0.05 * A });
    if (above <= 3 && e9[i] < e21[i] && touchH && b.close < p.low && b.close < vwap[i]) out.push({ name: "PULLBACK", dir: "P", stop: highN(3) + 0.05 * A });
  }
  // RECLAIM
  if (i >= 7 && mins <= 930) {
    const prevBelow = bars.slice(i - 6, i).every((x, k) => x.close < vwap[i - 6 + k]), prevAbove = bars.slice(i - 6, i).every((x, k) => x.close > vwap[i - 6 + k]);
    const okB = v => br == null || br[i] == null || v;
    if (prevBelow && b.close > vwap[i] && okB(br?.[i] >= 0.6)) out.push({ name: "RECLAIM", dir: "C", stop: lowN(4) - 0.05 * A });
    if (prevAbove && b.close < vwap[i] && okB(br?.[i] <= 0.4)) out.push({ name: "RECLAIM", dir: "P", stop: highN(4) + 0.05 * A });
  }
  // FLUSH (10:00–11:30)
  if (mins >= 600 && mins <= 690 && open) {
    const first = bars.slice(0, Math.min(i + 1, 12)), lo = Math.min(...first.map(x => x.low)), hi = Math.max(...first.map(x => x.high));
    const crossedUp = p.close <= open && b.close > open, crossedDn = p.close >= open && b.close < open;
    if (lo <= open * 0.996 && crossedUp) out.push({ name: "FLUSH", dir: "C", stop: Math.max(lo, b.close - 3 * A) });
    if (hi >= open * 1.004 && crossedDn) out.push({ name: "FLUSH", dir: "P", stop: Math.min(hi, b.close + 3 * A) });
  }
  // BREADTH
  if (br && i >= 6 && mins <= 930 && br[i] != null) {
    const win = br.slice(i - 6, i).filter(x => x != null);
    if (win.length && Math.min(...win) <= 0.3 && br[i] >= 0.8) out.push({ name: "BREADTH", dir: "C", stop: lowN(6) - 0.05 * A });
    if (win.length && Math.max(...win) >= 0.7 && br[i] <= 0.2) out.push({ name: "BREADTH", dir: "P", stop: highN(6) + 0.05 * A });
  }
  // Mantıksız stop (yanlış tarafta ya da çok dar/çok geniş) → ele
  return out.filter(s => (s.dir === "C" ? b.close - s.stop : s.stop - b.close) >= 0.3 * A && Math.abs(b.close - s.stop) <= 4 * A);
}

// Genişlik: her zaman damgasında sektör ETF'lerinin kendi VWAP'ı üstündeki oranı. secBars: { ETF: [5dk mum] } (aynı gün)
export function breadthSeries(tsList, secBars) {
  const maps = Object.values(secBars).map(arr => {
    const f = dayFeatures(arr), m = new Map();
    arr.forEach((x, k) => m.set(x.ts, x.close > f.vwap[k] ? 1 : 0));
    return m;
  });
  return tsList.map(ts => {
    const xs = maps.map(m => m.get(ts)).filter(x => x != null);
    return xs.length >= 6 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  });
}

// Sonuç (araştırma + karne ile aynı mantık): giriş = mum kapanışı, sonraki mumlarda önce STOP (aynı mumda ikisi = STOP),
// sonra HEDEF (2R), ufuk dolarsa son kapanış. Dönüş: R katı
export function outcomeR(bars, i, dir, stop, horizonBars, rr = 2) {
  const S = bars[i].close, R = Math.abs(S - stop), up = dir === "C", tgt = up ? S + rr * R : S - rr * R;
  if (!(R > 0)) return 0;
  for (let k = i + 1; k <= Math.min(bars.length - 1, i + horizonBars); k++) {
    const x = bars[k];
    if (up ? x.low <= stop : x.high >= stop) return -1;
    if (up ? x.high >= tgt : x.low <= tgt) return rr;
  }
  const last = bars[Math.min(bars.length - 1, i + horizonBars)].close;
  return ((up ? 1 : -1) * (last - S)) / R;
}
