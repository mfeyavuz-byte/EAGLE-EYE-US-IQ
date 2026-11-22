// ETF KISA VADE SİNYALİ (SPY, QQQ) — "yükselen trendde kısa vadeli aşırı satım" (research/etf.mjs).
// GİRİŞ: kapanış > 200 günlük ortalama VE RSI(2) < eşik (güçlü: < 5, normal: < 10)
// ÇIKIŞ: kapanış > 5 günlük ortalama ya da en çok 10 işlem günü.
// Ölçüm (1993/1999–2026, eğitim < 2014 ≤ test), dayanak üzerinde:
//   SPY RSI2<5: isabet %82 / %78 · ort +%0.82 / +%0.63 · ~3.3 gün   (taban: her gün al 4 gün tut %56/%60, +%0.13/+%0.19)
//   QQQ RSI2<5: isabet %71 / %81 · ort +%0.67 / +%0.72 · ~3.5 gün
//   Düşüş yönü (put) kuralları tutarsız → kullanılmaz.
export const ETFS_FAST = ["SPY", "QQQ"];
export const ETF_CFG = { RSI_STRONG: 5, RSI_NORMAL: 10, MAXD: 10 };

export function rsiSeries(c, n = 2) {
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
export const smaAt = (c, i, n) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; };

// closes: kapanışlar (son eleman = bugün/şimdiki fiyat). Dönüş: { tier: "güçlü"|"normal"|null, rsi2, up200, sma5, sma200, exit }
export function etfState(closes) {
  const i = closes.length - 1;
  if (i < 200) return null;
  const r = rsiSeries(closes, 2)[i], s200 = smaAt(closes, i, 200), s5 = smaAt(closes, i, 5), p = closes[i];
  const up200 = p > s200;
  const tier = up200 && r < ETF_CFG.RSI_STRONG ? "güçlü" : up200 && r < ETF_CFG.RSI_NORMAL ? "normal" : null;
  return { tier, rsi2: r, up200, sma5: s5, sma200: s200, price: p, exit: p > s5 };
}
