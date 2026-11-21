// Volatilite analitiği: gerçekleşen oynaklık (HV), ATM IV, 30 günlük sabit vadeli IV, vade yapısı,
// skew, IV rank/yüzdelik, beklenen hareket ve oynaklık rejimi.

const ANN = Math.sqrt(252);

// Kapanıştan kapanışa HV (yıllık).
export function hvC2C(rows, n) {
  if (rows.length < n + 1) return null;
  const r = [];
  for (let i = rows.length - n; i < rows.length; i++) r.push(Math.log(rows[i].close / rows[i - 1].close));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * ANN;
}

// Yang-Zhang HV (açılış boşlukları + gün içi aralık) — kapanış-kapanıştan daha verimli tahminci.
export function hvYZ(rows, n) {
  if (rows.length < n + 1) return null;
  const w = rows.slice(-n - 1);
  const o = [], c = [], rs = [];
  for (let i = 1; i < w.length; i++) {
    const { open: O, high: H, low: L, close: C } = w[i], pc = w[i - 1].close;
    if (!(O > 0 && H > 0 && L > 0 && C > 0 && pc > 0)) continue;
    o.push(Math.log(O / pc)); c.push(Math.log(C / O));
    rs.push(Math.log(H / C) * Math.log(H / O) + Math.log(L / C) * Math.log(L / O));
  }
  const N = o.length;
  if (N < 10) return hvC2C(rows, n);
  const v = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); };
  const k = 0.34 / (1.34 + (N + 1) / (N - 1));
  const rsAvg = rs.reduce((a, b) => a + b, 0) / N;
  return Math.sqrt(Math.max(0, v(o) + k * v(c) + (1 - k) * rsAvg)) * ANN;
}

// Bir vadenin ATM IV'si: forward'a en yakın iki strike'ta call+put IV ortalaması, doğrusal ara değer.
export function atmIV(ex, S, r, q) {
  const F = S * Math.exp((r - q) * ex.T);
  const ivAt = K => {
    const c = ex.calls.find(o => o.K === K)?.iv, p = ex.puts.find(o => o.K === K)?.iv;
    return c && p ? (c + p) / 2 : (c || p || null);
  };
  const Ks = [...new Set([...ex.calls, ...ex.puts].filter(o => o.iv).map(o => o.K))].sort((a, b) => a - b);
  if (!Ks.length) return null;
  let lo = Ks.filter(k => k <= F).pop(), hi = Ks.find(k => k >= F);
  if (lo == null) lo = hi; if (hi == null) hi = lo;
  const a = ivAt(lo), b = ivAt(hi);
  if (!a || !b) return a || b;
  return hi === lo ? a : a + (b - a) * (F - lo) / (hi - lo);
}

// Delta'ya göre IV (skew için): |delta|'sı hedefe en yakın likit-olmasa-da-fiyatlı kontrat.
function ivAtDelta(list, target) {
  const c = list.filter(o => o.iv && o.delta != null).sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target))[0];
  return c && Math.abs(c.delta - target) < 0.1 ? c.iv : null;
}

// Sabit 30 günlük IV: 30 günü saran iki vade arasında TOPLAM VARYANS (σ²T) ile zaman ara değeri.
function iv30From(pts) {
  const T30 = 30 / 365;
  const below = pts.filter(p => p.T <= T30).pop(), above = pts.find(p => p.T >= T30);
  if (below && above && above.T > below.T) {
    const w1 = below.iv ** 2 * below.T, w2 = above.iv ** 2 * above.T;
    return Math.sqrt((w1 + (w2 - w1) * (T30 - below.T) / (above.T - below.T)) / T30);
  }
  return (above || below)?.iv ?? null;
}

// IV rank (52h aralıktaki konum) ve yüzdelik (geçmiş günlerin yüzde kaçı bugünden düşük).
export function ivRankPct(hist, cur) {
  if (!hist || hist.length < 20 || !cur) return { rank: null, pct: null, n: hist?.length || 0 };
  const lo = Math.min(...hist), hi = Math.max(...hist);
  return {
    rank: hi > lo ? Math.round(Math.max(0, Math.min(1, (cur - lo) / (hi - lo))) * 100) : 50,
    pct: Math.round(hist.filter(v => v < cur).length / hist.length * 100), n: hist.length,
  };
}

// Tam volatilite panosu. dailyRows: dayanak hissenin günlük mumları. hist: geçmiş IV30 listesi.
export function volDashboard(chain, dailyRows, hist = null) {
  const { S, r, q } = chain;
  const pts = chain.expiries.map(ex => ({ exp: ex.exp, dte: ex.dte, T: ex.T, iv: atmIV(ex, S, r, q) })).filter(p => p.iv);
  const iv30 = iv30From(pts);
  const hv20 = hvC2C(dailyRows, 20), hv60 = hvC2C(dailyRows, 60), yz20 = hvYZ(dailyRows, 20);
  const front = pts.find(p => p.dte >= 7), back = pts.filter(p => p.dte >= 55).shift();
  const termRatio = front && back && back.dte > front.dte ? front.iv / back.iv : null;  // >1 = ters vade yapısı (olay/stres)
  const ex30 = chain.expiries.slice().sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))[0];
  const p25 = ex30 ? ivAtDelta(ex30.puts, -0.25) : null, c25 = ex30 ? ivAtDelta(ex30.calls, 0.25) : null;
  const skew = p25 && c25 ? p25 - c25 : null;                                          // >0: put'lar pahalı (korku)
  // Beklenen hareket: ~30 günlük vadede ATM straddle fiyatı (piyasanın ±1σ'ya yakın fiyatlaması)
  let expMove = null;
  if (ex30) {
    const K = [...ex30.calls].sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S))[0]?.K;
    const c = ex30.calls.find(o => o.K === K), p = ex30.puts.find(o => o.K === K);
    if (c?.mid && p?.mid) expMove = { usd: c.mid + p.mid, pct: (c.mid + p.mid) / S, dte: ex30.dte };
  }
  // Gerçekleşen oynaklık tahmini: kısa (YZ20) ve uzun (HV60) ortalaması — ama ASLA son 20 günün altında değil
  // (sakin geçmiş, bugünkü stresi gizlemesin).
  const hvBlend = [yz20, hv60].filter(Boolean);
  const hvF = hvBlend.length ? Math.max(yz20 || 0, hvBlend.reduce((a, b) => a + b, 0) / hvBlend.length) : null;
  const ivhv = iv30 && hvF ? iv30 / hvF : null;
  const { rank, pct, n } = ivRankPct(hist, iv30);
  // REJİM: IV geçmişi yeterliyse IV rank, değilse IV/HV oranı (oynaklık risk primi) belirler.
  let regime = "adil";
  if (rank != null) regime = rank >= 50 && (ivhv ?? 1.1) >= 1.0 ? "zengin" : rank <= 25 || (ivhv != null && ivhv < 0.9) ? "ucuz" : "adil";
  else if (ivhv != null) regime = ivhv >= 1.25 ? "zengin" : ivhv <= 0.95 ? "ucuz" : "adil";
  const earnDays = chain.earningsTs ? (chain.earningsTs * 1e3 - Date.now()) / 864e5 : null;
  return { S, iv30, hv20, hv60, yz20, hvF, ivhv, termRatio, skew, expMove, rank, pct, histN: n, regime, earnDays, term: pts };
}
