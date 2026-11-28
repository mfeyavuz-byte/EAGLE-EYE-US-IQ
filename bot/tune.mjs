// KARNEYE GÖRE EŞİK AYARI — 15 dk fikrinin skor eşiği ve ani hareket alarmının σ (z) eşiği, gerçekleşen sonuçlara göre
// günde 1 kez (tarama) yeniden seçilir ve küçük bir Gist dosyasına (abd_tune.json) yazılır; 15 dk ve ani hareket süreçleri okur.
// Yöntem (aşırı uyuma karşı ihtiyatlı): yalnız varsayılandan SIKIYA doğru aday eşikler denenir (gevşetme yok — eşiğin
// altındaki fikirler hiç gönderilmediği için onları ölçemeyiz). En az MIN_TOTAL sonuçlanmış fikir yoksa varsayılan kalır.
// Seçim: ortalaması pozitif ve en az MIN_N fikri olan EN DÜŞÜK eşik; hiçbiri pozitif değilse en seçici eşik + uyarı.
export const TUNE_FILE = "abd_tune.json";
export const TUNE = {
  idx: { key: "score", cands: [3, 3.5, 4, 4.5], def: 3, lab: "15 dk skor" },
  fast: { key: "z", cands: [3.5, 4, 4.5, 5], def: 3.5, lab: "ani hareket σ" },
  MIN_N: 20, MIN_TOTAL: 40,
};
const fr = x => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;

export function tuneOne(ideas, cfg, minN = TUNE.MIN_N, minTotal = TUNE.MIN_TOTAL) {
  const done = (ideas || []).filter(i => i.res && i.res !== "geçersiz" && i[cfg.key] != null);
  if (done.length < minTotal) return { value: cfg.def, n: done.length, why: `veri yetersiz (${done.length}/${minTotal} sonuçlanmış fikir) → varsayılan` };
  const rows = cfg.cands.map(t => {
    const sub = done.filter(i => Math.abs(i[cfg.key]) >= t - 1e-9);
    return { t, n: sub.length, avg: sub.length ? sub.reduce((a, i) => a + i.r, 0) / sub.length : null };
  });
  const ok = rows.find(r => r.n >= minN && r.avg > 0);
  if (ok) return { value: ok.t, n: done.length, why: `≥ ${ok.t}: ${ok.n} fikir, ort. ${fr(ok.avg)}` };
  return { value: cfg.cands.at(-1), n: done.length, warn: true, why: `hiçbir eşikte ortalama pozitif değil → en seçici eşik (${cfg.cands.at(-1)})` };
}

export function tuneAll(books, today) {
  return { d: today, idx: tuneOne(books?.idx?.ideas, TUNE.idx), fast: tuneOne(books?.fast?.ideas, TUNE.fast) };
}
// Süreçlerin kullanacağı değer: yalnız aday listesindeyse kabul (bozuk/eski dosyaya karşı)
export const tunedValue = (file, k) => (TUNE[k].cands.includes(file?.[k]) ? file[k] : TUNE[k].def);

export function fmtTune(t) {
  if (!t?.fast) return "🎚 Eşik ayarı: henüz hesaplanmadı.";
  return `🎚 Eşik ayarı (karneye göre, ${t.d}): ${TUNE.fast.lab} ≥ ${t.fast.value} (${t.fast.why})` +
    (t.fast.warn ? "\n⚠ Bazı fikir türleri karnede kaybettiriyor — eşik en seçiciye çekildi; sonuçlar düzelmezse o tür kapatılmalı." : "");
}
