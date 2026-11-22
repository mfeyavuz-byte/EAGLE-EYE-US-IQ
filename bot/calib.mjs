// CANLI KALİBRASYON — bot kendi kapanmış spot sinyallerinden "yön avantajı"nı günceller.
// Araştırmadaki değer bir ÖNSEL (prior) kabul edilir; canlı sonuçlar geldikçe ona doğru/ondan uzağa çekilir:
//   sonsal = (n · gözlenen + K · önsel) / (n + K)      (K = önselin "işlem sayısı" ağırlığı)
// Gözlenen = kapanmış sinyallerin SPY'a göre fazla getirisi, 21 işlem gününe ölçeklenmiş (aylık).
// Opsiyon motoru bu değeri (yıllık) kayma olarak kullanır → canlı kötüyse bot kendiliğinden temkinliye geçer.
// aylık; O TARİHTEKİ S&P 500 üyeleriyle (hayatta kalan yanlılığı yok) ölçülen ortalamanın YARISI
// (opsiyon kazancı uç hareketlerden geldiği için kırpılmamış ortalama): AL +%1.8 → +%0.9 · SAT −%0.8 → +%0.4 (doğru yön)
export const PRIOR = { AL: 0.009, SAT: 0.004 };
export const K = +(process.env.CALIB_K || 30);
export const MIN_N = 10;                            // bundan az kapanmış işlemde önsel aynen kullanılır
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Dönüş: { AL: {n, obsM, postM, annual, warn}, SAT: {...}, at }
export function calibrate(book, today) {
  const out = { at: today };
  for (const sig of ["AL", "SAT"]) {
    const c = (book || []).filter(b => b.sig === sig && b.closed && isFinite(b.closed.ex) && b.closed.td > 0);
    const n = c.length;
    const avgTd = n ? c.reduce((a, b) => a + b.closed.td, 0) / n : 21;
    const obsM = n ? c.reduce((a, b) => a + b.closed.ex, 0) / n * 21 / Math.max(5, avgTd) : null;
    const postM = n >= MIN_N ? (n * obsM + K * PRIOR[sig]) / (n + K) : PRIOR[sig];
    out[sig] = {
      n, obsM, postM, annual: clamp(postM * 12, -0.05, 0.15),
      warn: n >= 30 && obsM <= 0,                   // yeterli veriyle avantaj yok → uyarı
    };
  }
  return out;
}

const pc = v => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
export function fmtCalib(c) {
  if (!c?.AL) return "Kalibrasyon: henüz veri yok.";
  const line = (s, lab) => `${lab}: ${c[s].n} kapanmış sinyal · gözlenen ${pc(c[s].obsM)}/ay · kullanılan ${pc(c[s].postM)}/ay (yıllık ${pc(c[s].annual)})` +
    (c[s].n < MIN_N ? " · önsel (veri az)" : "") + (c[s].warn ? " · ⚠ CANLIDA AVANTAJ YOK" : "");
  return ["🎚 Yön kalibrasyonu (canlı sonuç + araştırma önseli)", line("AL", "AL"), line("SAT", "SAT (doğru = +)")].join("\n");
}
