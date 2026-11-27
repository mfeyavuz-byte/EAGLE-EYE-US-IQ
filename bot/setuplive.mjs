// CANLI KURULUM SEÇİMİ — research/intraday.mjs'in 1 yıllık ölçümünü geçen kurulumlar (Gist: abd_setups.json) canlıda gönderilir.
// Eşik: n ≥ 40 · ortalama ≥ +0.15R · t ≥ 2 (şans değil). Gün parçası bazında da geçebilir (ör. yalnız sabah).
// Liste yoksa / boşsa HİÇBİR kurulum gönderilmez (ölçülmemiş fikir yok). Ölçüm her hafta kendiliğinden yenilenir.
export const SETUPS_FILE = "abd_setups.json";
export const ALLOW_RULE = { N: 40, M: 0.15, T: 2 };
export const partOf = mins => (mins < 690 ? "sabah" : mins < 840 ? "öğle" : "öğleden sonra");

// rows: [{ name, dir, hor, n, m, t, part: { sabah: {n,m,t}, ... } }] → izinli liste
export function buildAllow(rows, R = ALLOW_RULE) {
  const ok = s => s.n >= R.N && s.m >= R.M && s.t >= R.T, out = [];
  for (const r of rows || []) {
    if (!r.name || r.name === "ESKİ_SKOR") continue;
    if (ok(r)) out.push({ name: r.name, dir: r.dir, hor: r.hor, part: "tümü", n: r.n, m: +r.m.toFixed(3), t: +r.t.toFixed(2) });
    else for (const [p, s] of Object.entries(r.part || {})) if (ok(s)) out.push({ name: r.name, dir: r.dir, hor: r.hor, part: p, n: s.n, m: +s.m.toFixed(3), t: +s.t.toFixed(2) });
  }
  return out;
}

// Bu kurulum şu an gönderilebilir mi? En iyi (en yüksek ortalama) eşleşme | null
export function allowedFor(allow, name, dir, mins) {
  const p = partOf(mins);
  return (allow || []).filter(a => a.name === name && a.dir === dir && (a.part === "tümü" || a.part === p)).sort((a, b) => b.m - a.m)[0] || null;
}

export const SETUP_LABEL = {
  PULLBACK: { C: "trend içi geri çekilmeden dönüş", P: "düşüş trendinde tepkiden dönüş" },
  RECLAIM: { C: "VWAP geri alındı", P: "VWAP kaybedildi" },
  FLUSH: { C: "açılış düşüşü sindirildi", P: "açılış yükselişi silindi" },
  BREADTH: { C: "piyasa genişliği yukarı döndü", P: "piyasa genişliği aşağı döndü" },
};
