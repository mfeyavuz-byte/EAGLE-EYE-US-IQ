// YÖNETİLEN İŞLEM SİMÜLASYONU + KELLY BOYUTU
//
// Neden? Vade-sonu EV'si "opsiyonu vadeye kadar tut" varsayar. Oysa mesajdaki kurallar erken çıkar
// (+%100 kâr al, −%50 zarar durdur, vadeye 21 gün kala kapat). Erken çıkış getiri dağılımını tamamen değiştirir.
// Burada her senaryo GÜN GÜN yürütülür, her gün opsiyon Black-Scholes ile (giriş IV'siyle) değerlenir ve aynı
// kurallar uygulanır → önerdiğimiz İŞLEMİN gerçek beklenen değeri, kazanma oranı, ortalama süresi.
//
// Fiyat yolu: günlük log-getiri, senaryo başına rastgele oynaklık çarpanı (stokastik oynaklık karışımı →
// her ufukta kalın kuyruk; E[çarpan] = 1 olduğundan ortalama oynaklık σ kalır). Kayma: μ (yıllık).
// Çıkış fiyatı: BS değeri × (1 − SLIP·girişteki spread%) — kapatırken de spread'in bir kısmını öderiz.
//
// KELLY: işlem başına riske edilen sermaye oranı f için büyüme g(f) = E[ln(1 + f·R)], R = K/Z ÷ ödenen prim.
// f* = argmax g. Pratikte ¼ Kelly kullanılır (tahmin hatasına karşı), üst sınır OCFG.RISK (%2).
// f* = 0 → bu işlem uzun vadede sermayeyi büyütmez → önerilmez.
import { bs } from "./bs.mjs";
import { SLIP } from "./strategies.mjs";

// Tekrarlanabilir rastgelelik (aynı girdi → aynı sonuç; testler ve mesajlar tutarlı)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function normals(rand) {
  let spare = null;
  return () => {
    if (spare != null) { const v = spare; spare = null; return v; }
    let u, v, w;
    do { u = 2 * rand() - 1; v = 2 * rand() - 1; w = u * u + v * v; } while (w >= 1 || w === 0);
    const m = Math.sqrt(-2 * Math.log(w) / w);
    spare = v * m; return u * m;
  };
}

// legs: [{type, K, side, iv, sp}] (sp: girişteki spread oranı) · debit: hisse başına ödenen (dolum dahil)
// rules: {tp, sl, dte, maxDays?} ($/kontrat, gün; maxDays: bilanço öncesi en geç çıkış, takvim günü)
// T: vadeye yıl · sigma: fiziksel yıllık oynaklık · mu: yıllık kayma
export function simulateManaged({ S0, T, sigma, mu, r, q = 0, legs, debit, rules, n = 2000, volOfVol = 0.15, seed = 7 }) {
  const days = Math.max(1, Math.round(T * 365));
  const tradingDays = Math.max(1, Math.round(days * 252 / 365));
  const dt = T / tradingDays;
  const rand = rng(seed), N = normals(rand);
  const pnls = new Float64Array(n), held = new Float64Array(n);
  const reasons = { "kâr hedefi": 0, "zarar durdur": 0, "süre": 0, "bilanço öncesi": 0, "vade": 0 };
  const value = (S, tau) => {
    let v = 0;
    for (const l of legs) {
      const p = tau > 1e-6 ? bs(l.type, S, l.K, tau, r, q, l.iv || sigma).price : Math.max(0, l.type === "C" ? S - l.K : l.K - S);
      v += l.side * p * (1 - l.side * SLIP * (l.sp || 0));
    }
    return v;
  };
  for (let i = 0; i < n; i++) {
    // E[m] = 1 → ortalama oynaklık σ (ATM opsiyon değeri σ'ya ~doğrusal: adil fiyatlı ATM'nin EV'si ≈ 0 kalır);
    // dağılım kuyrukları ise karışım sayesinde kalınlaşır.
    const m = Math.exp(volOfVol * N() - volOfVol * volOfVol / 2);
    const s = sigma * m, drift = (mu - 0.5 * s * s) * dt, sd = s * Math.sqrt(dt);
    let S = S0, out = null;
    for (let d = 1; d <= tradingDays; d++) {
      S *= Math.exp(drift + sd * N());
      const tau = T - d * dt, calLeft = tau * 365;
      const pnl = (value(S, tau) - debit) * 100;
      let why = null;
      if (rules?.sl != null && pnl <= rules.sl) why = "zarar durdur";
      else if (rules?.tp != null && pnl >= rules.tp) why = "kâr hedefi";
      else if (rules?.dte != null && calLeft <= rules.dte) why = "süre";
      else if (rules?.maxDays != null && d * 365 / 252 >= rules.maxDays) why = "bilanço öncesi";   // IV çöküşüne girme
      else if (d === tradingDays) why = "vade";
      if (why) { out = { pnl, d, why }; break; }
    }
    pnls[i] = out.pnl; held[i] = out.d * 365 / 252; reasons[out.why]++;
  }
  const sorted = Float64Array.from(pnls).sort();
  const ev = pnls.reduce((a, b) => a + b, 0) / n;
  const k5 = Math.max(1, Math.floor(n * 0.05));
  return {
    ev, pop: pnls.filter(x => x > 0).length / n,
    cvar5: sorted.slice(0, k5).reduce((a, b) => a + b, 0) / k5,
    days: held.reduce((a, b) => a + b, 0) / n,
    reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, v / n])),
    pnls,
  };
}

// Kelly: R_i = pnl_i / risk (risk = maks zarar, $). g(f) = ort ln(1 + f·R). Dönüş { f, g } (f ∈ [0, 1)).
export function kelly(pnls, risk) {
  if (!(risk > 0)) return { f: 0, g: 0 };
  const R = Array.from(pnls, x => Math.max(-0.999, x / risk));
  const g = f => R.reduce((a, x) => a + Math.log1p(f * x), 0) / R.length;
  if (g(0.001) <= 0) return { f: 0, g: 0 };
  let lo = 0, hi = 0.99;                                               // g içbükey → altın oran araması
  for (let it = 0; it < 60; it++) {
    const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618;
    if (g(a) < g(b)) lo = a; else hi = b;
  }
  const f = (lo + hi) / 2;
  return { f, g: g(f) };
}
