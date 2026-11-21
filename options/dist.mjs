// Vadedeki fiyat dağılımı + bir stratejinin bu dağılım altındaki beklenen değeri.
//
// Neden ikisi birden?
//  • Piyasa (risk-nötr) dağılımı: log-normal, σ = opsiyonun IV'si. "Piyasanın verdiği" kâr olasılığı.
//  • Fiziksel (bizim) dağılımımız: KALIN KUYRUKLU Student-t (ν=4), σ = gerçekleşen oynaklık tahmini
//    + sinyal yönüne göre küçük bir eğim. Hisse getirileri normalden kalın kuyrukludur; normal dağılım
//    kısa opsiyon satışının riskini olduğundan düşük gösterir. Beklenen değeri (EV) BURADAN hesaplarız.
// Bir stratejinin "avantajı" (edge) = fiziksel dağılımda beklenen kâr − işlem maliyeti (spread kayması dahil).

const T_NU = 4, T_CONST = 0.375;   // ν=4 için Γ(2.5)/(√(4π)·Γ(2)) = 3/8
const tPdf = x => T_CONST * Math.pow(1 + x * x / T_NU, -(T_NU + 1) / 2);

// ÇARPIKLIK (skew): hisse getirileri sola çarpıktır (sert düşüşler sert yükselişlerden sık) ve put'lar bunu fiyatlar.
// "İki parçalı" dönüşüm: standart değişken z<0 ise a=(1+k), z≥0 ise b=(1−k) ile ölçeklenir → medyan 0 kalır,
// sol kuyruk kalınlaşır. Toplam varyans korunur; ortalama ayrıca E[S_T] = S0·e^{μT} olacak şekilde ayarlanır.
// k: piyasa skew'undan türetilir (bkz. skewK). k=0 → simetrik.
export function skewK(skew, atmIv, share = 1) {
  if (!skew || !atmIv || skew <= 0) return 0;
  return Math.min(0.3, share * skew / (2 * atmIv));
}

// Dönüş: { S: Float64Array(vadedeki fiyatlar), p: Float64Array(olasılıklar, toplam 1) }
// model: "lognormal" | "t". mu: yıllık beklenen getiri (basit). sigma: yıllık. k: sola çarpıklık (0..0.3).
export function terminalDist(S0, T, sigma, mu = 0, model = "t", N = 801, k = 0) {
  const sd = sigma * Math.sqrt(Math.max(T, 1 / 365));
  const S = new Float64Array(N), p = new Float64Array(N);
  const isT = model !== "lognormal";
  const lim = isT ? 14 : 8;                                   // t için ±14 ölçek biriminde kesilir
  const base = isT ? sd * Math.sqrt((T_NU - 2) / T_NU) : sd;  // varyans eşleştirme (t: ν/(ν−2) düzeltmesi)
  const s = base / Math.sqrt(((1 + k) ** 2 + (1 - k) ** 2) / 2);   // iki parçalı ölçeklemede varyansı koru
  const y = new Float64Array(N);
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const z = -lim + 2 * lim * i / (N - 1);
    p[i] = isT ? tPdf(z) : Math.exp(-z * z / 2);
    y[i] = s * z * (z < 0 ? 1 + k : 1 - k);
    tot += p[i];
  }
  for (let i = 0; i < N; i++) p[i] /= tot;
  // Kaymayı E[S_T] = S0·e^{μT} olacak şekilde sayısal ayarla (kesilmiş/çarpık dağılımda da tam doğru).
  let mgf = 0;
  for (let i = 0; i < N; i++) mgf += p[i] * Math.exp(y[i]);
  const m = mu * T - Math.log(mgf);
  for (let i = 0; i < N; i++) S[i] = S0 * Math.exp(m + y[i]);
  return { S, p };
}

// Vade sonu kâr/zarar (hisse başına). legs: [{type:"C"|"P", K, side:+1 alış / −1 satış, qty}]
export function payoffAt(legs, ST) {
  let v = 0;
  for (const l of legs) v += l.side * (l.qty || 1) * (l.type === "C" ? Math.max(0, ST - l.K) : Math.max(0, l.K - ST));
  return v;
}

// Strateji istatistikleri: debit = ödenen net prim (hisse başına; kredi ise negatif).
// Dönüş (kontrat başına $): ev, pop, cvar5 (en kötü %5'in ortalama zararı)
export function evaluate(legs, debit, dist) {
  const { S, p } = dist;
  let ev = 0, pop = 0;
  const pnl = new Float64Array(S.length);
  for (let i = 0; i < S.length; i++) {
    pnl[i] = (payoffAt(legs, S[i]) - debit) * 100;
    ev += p[i] * pnl[i];
    if (pnl[i] > 0) pop += p[i];
  }
  // CVaR %5: P&L'yi sırala, en kötü %5 olasılık kütlesinin ortalaması
  const idx = Array.from(pnl.keys()).sort((a, b) => pnl[a] - pnl[b]);
  let mass = 0, acc = 0;
  for (const i of idx) {
    const take = Math.min(p[i], 0.05 - mass);
    if (take <= 0) break;
    acc += take * pnl[i]; mass += take;
  }
  return { ev, pop, cvar5: mass > 0 ? acc / mass : 0 };
}

// Maks kâr/zarar ve başabaş noktaları — vade sonu kâr/zararı parça parça doğrusaldır;
// uç değerler kırılma noktalarında (strike'lar) veya sonsuzdadır.
export function profile(legs, debit) {
  const Ks = [...new Set(legs.map(l => l.K))].sort((a, b) => a - b);
  const pts = [0, ...Ks, Ks[Ks.length - 1] * 10];
  const vals = pts.map(x => (payoffAt(legs, x) - debit) * 100);
  // Sonsuza giden eğim: net alınmış call sayısı
  const callNet = legs.filter(l => l.type === "C").reduce((a, l) => a + l.side * (l.qty || 1), 0);
  const maxProfit = callNet > 0 ? Infinity : Math.max(...vals);
  const maxLoss = callNet < 0 ? Infinity : -Math.min(...vals);
  const be = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = vals[i], b = vals[i + 1];
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) be.push(+(pts[i] + (pts[i + 1] - pts[i]) * (-a) / (b - a)).toFixed(2));
  }
  return { maxProfit, maxLoss: Math.max(0, maxLoss), breakevens: [...new Set(be)] };
}
