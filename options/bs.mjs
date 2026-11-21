// Black-Scholes-Merton (sürekli temettü getirisi q ile) — fiyat, Greek'ler, örtük volatilite.
// Not: ABD hisse opsiyonları Amerikan tipidir; erken kullanım primi ATM/OTM'de çok küçüktür.
// IV'yi de aynı modelle çözdüğümüz için fiyat/IV/Greek'ler birbiriyle tutarlıdır.

// Standart normal CDF — Graeme West (Hart) algoritması, ~1e-14 doğruluk.
export function normCdf(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165; n = n * z + 33.912866078383; n = n * z + 112.079291497871;
      n = n * z + 221.213596169931; n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674;
      d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
      c = e * n / d;
    } else {
      let b = z + 0.65; b = z + 4 / b; b = z + 3 / b; b = z + 2 / b; b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}
export const normPdf = x => Math.exp(-x * x / 2) / 2.5066282746310002;

// type: "C" | "P". T yıl, r ve q yıllık sürekli, sigma yıllık.
export function bs(type, S, K, T, r, q, sigma) {
  if (T <= 0 || sigma <= 0) {
    const intr = type === "C" ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intr, delta: type === "C" ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, vega: 0, theta: 0 };
  }
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sq), d2 = d1 - sigma * sq;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T), pdf = normPdf(d1);
  const gamma = dq * pdf / (S * sigma * sq);
  const vega = S * dq * pdf * sq / 100;                                   // 1 vol puanı başına
  const common = -S * dq * pdf * sigma / (2 * sq);
  if (type === "C") {
    return {
      price: S * dq * normCdf(d1) - K * dr * normCdf(d2), delta: dq * normCdf(d1), gamma, vega,
      theta: (common - r * K * dr * normCdf(d2) + q * S * dq * normCdf(d1)) / 365,   // gün başına
    };
  }
  return {
    price: K * dr * normCdf(-d2) - S * dq * normCdf(-d1), delta: dq * (normCdf(d1) - 1), gamma, vega,
    theta: (common + r * K * dr * normCdf(-d2) - q * S * dq * normCdf(-d1)) / 365,
  };
}

// Örtük volatilite — aralık daraltma (bisection): fiyat σ'da monoton → her zaman yakınsar.
// Fiyat arbitraj sınırının altındaysa (iç değerden ucuz) null.
export function impliedVol(type, price, S, K, T, r, q) {
  if (!(price > 0) || !(T > 0)) return null;
  const lower = type === "C" ? Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T)) : Math.max(0, K * Math.exp(-r * T) - S * Math.exp(-q * T));
  const upper = type === "C" ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (price <= lower + 1e-6 || price >= upper) return null;
  let lo = 0.005, hi = 5;
  if (bs(type, S, K, T, r, q, hi).price < price) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bs(type, S, K, T, r, q, mid).price > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}
