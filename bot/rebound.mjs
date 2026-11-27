// AŞIRI SATIM → HIZLI DÖNÜŞ — kaliteli ve uzun vadede yükselen hisse kısa vadede sert satılınca (RSI(2) çok düşük)
// birkaç gün içinde ortalamaya dönme eğilimi. Kurallar research/rebound.mjs ile 2015 sonrası ölçülerek seçildi.
// Giriş: kapanışa yakın · Hedef: kapanış 5 günlük ortalamanın üstüne çıkınca (≈ 10 günlük ortalama seviyesi) ·
// Stop: giriş − 2 × ATR(14) · Zaman: en çok 10 işlem günü. Kalite: zarar eden / nakit yakan elenir (bot/edge.mjs).
export const REB = { MAX_HOLD: 10, RSI2: 5, ATR_STOP: 2, MAX_LIST: 8 };

function rsiN(c, n) {
  if (c.length <= n + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - n * 5 > 1 ? c.length - n * 5 : 1, k = 0; i < c.length; i++, k++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (k < n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const sma = (c, n) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
function atr14(rows) {
  const r = rows.slice(-15);
  let s = 0;
  for (let i = 1; i < r.length; i++) s += Math.max(r[i].high - r[i].low, Math.abs(r[i].high - r[i - 1].close), Math.abs(r[i].low - r[i - 1].close));
  return r.length > 1 ? s / (r.length - 1) : null;
}

// rows: günlük (eskiden yeniye; son satır = bugün/canlı). opt: { rsi2, deep (ATR katı | null), need200, down3 }
// Dönüş: { rsi2, atr, sma5, sma10, sma200, close, stop, target } | null
export function reboundSignal(rows, opt = {}) {
  const o = { rsi2: REB.RSI2, deep: null, need200: true, down3: false, ...opt };
  if (!rows || rows.length < 210) return null;
  const c = rows.map(r => r.close), close = c.at(-1);
  const r2 = rsiN(c, 2), s200 = sma(c, 200);
  if (r2 == null || r2 >= o.rsi2) return null;
  if (o.need200 && !(close > s200)) return null;
  const A = atr14(rows), s20 = sma(c, 20);
  if (o.deep != null && !(close <= s20 - o.deep * A)) return null;
  if (o.down3 && !(c.at(-1) < c.at(-2) && c.at(-2) < c.at(-3) && c.at(-3) < c.at(-4))) return null;
  return { rsi2: +r2.toFixed(1), atr: A, sma5: sma(c, 5), sma10: sma(c, 10), sma200: s200, close, stop: +(close - REB.ATR_STOP * A).toFixed(2), target: +Math.max(sma(c, 10), close * 1.01).toFixed(2) };
}

export function fmtRebound(list) {
  if (!list.length) return null;
  return ["🔄 AŞIRI SATIM — HIZLI DÖNÜŞ ADAYLARI (kaliteli, uzun vadede yükselen, sert satılmış)",
    ...list.map(x => `${x.sym} ${x.close.toFixed(2)} · Giriş kapanışa yakın · Hedef ${x.target} · Stop ${x.stop} · en çok 10 gün${x.contract ? ` · ${x.contract}` : ""}`)].join("\n");
}
