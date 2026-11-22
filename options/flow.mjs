// OPSİYON AKIŞI — olağandışı hacim (büyük oyuncuların yeni pozisyon açtığı kontratlar). Ücretsiz Yahoo zincirinden.
// Olağandışı: bugünkü hacim ≥ 3 × açık pozisyon ve ≥ 1.000 kontrat (ya da ≥ $1M prim ve ≥ 2 × OI).
// Veri kirliliğine karşı yalnız ANLAMLI kontratlar: |delta| 0.05–0.85 (derin ITM/uzak OTM değil), spread ≤ %25.
// Derin ITM kontratlardaki dev "hacim" çoğunlukla takas/kombine işlem ya da bayat kotasyondur → dahil edilmez.
export function unusualOptions(chain, top = 3) {
  const out = [];
  for (const ex of chain?.expiries || []) {
    for (const o of [...ex.calls, ...ex.puts]) {
      const d = Math.abs(o.delta ?? NaN);
      if (!(d >= 0.05 && d <= 0.85) || !(o.mid > 0) || (o.spreadPct ?? 1) > 0.25) continue;
      const vol = o.vol || 0, oi = Math.max(1, o.oi || 0), prem = vol * o.mid * 100;
      if ((vol >= 1000 && vol >= 3 * oi) || (prem >= 1e6 && vol >= 2 * oi)) {
        out.push({ type: o.type, K: o.K, exp: ex.exp, dte: ex.dte, vol, oi: o.oi || 0, prem, delta: o.delta });
      }
    }
  }
  return out.sort((a, b) => b.prem - a.prem).slice(0, top);
}
