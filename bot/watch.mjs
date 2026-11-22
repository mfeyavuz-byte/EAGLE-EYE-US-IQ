// TAKİP LİSTESİ — sahip olduğun hisseler için uyarılar (/takip SEMBOL · /birak SEMBOL · /takiplerim).
// Uyarılar (her biri hisse başına günde en çok 1 kez):
//  • bot o hisse için SAT seçimi verdi
//  • 200 günlük ortalamanın altına indi (yukarıdan aşağı kesiş)
//  • takibe alındıktan sonraki en yüksek fiyattan ≥ %8 geri çekildi (iz süren stop)
export const TRAIL = +(process.env.WATCH_TRAIL || 0.08);

export function addWatch(st, sym, px, today) {
  st.watch ||= {};
  if (st.watch[sym]) return false;
  st.watch[sym] = { d: today, px, hi: px, above200: null, alerted: {} };
  return true;
}
export function removeWatch(st, sym) {
  if (!st.watch?.[sym]) return false;
  delete st.watch[sym];
  return true;
}

// analyses: tarama sonuçları (sym → analiz). Dönüş: uyarı satırları.
export function checkWatch(st, analyses, today) {
  const out = [];
  for (const [sym, w] of Object.entries(st.watch || {})) {
    const a = analyses.get(sym);
    if (!a || !(a.price > 0)) continue;
    w.hi = Math.max(w.hi || a.price, a.price);
    w.last = a.price; w.pick = a.pick || null;
    const once = (key, msg) => { if (w.alerted[key] !== today) { w.alerted[key] = today; out.push(msg); } };
    if (a.pick === "SAT") once("sat", `🔴 ${sym}: bot SAT seçimi verdi (teyitli düşüş + zayıf momentum) · $${a.price}`);
    const above = a.a200 != null ? a.a200 > 0 : null;
    if (w.above200 === true && above === false) once("ma200", `⚠ ${sym}: 200 günlük ortalamanın altına indi · $${a.price} (${(a.a200 * 100).toFixed(1)}%)`);
    if (above != null) w.above200 = above;
    const dd = a.price / w.hi - 1;
    // iz süren stop: aynı zirve için bir kez (yeni zirve yapılırsa yeniden kurulur)
    if (dd <= -TRAIL && w.trailAt !== w.hi) { w.trailAt = w.hi; out.push(`⚠ ${sym}: takipteki zirvesinden ${(dd * 100).toFixed(1)}% geri çekildi ($${w.hi} → $${a.price})`); }
  }
  return out;
}

export function fmtWatch(st) {
  const e = Object.entries(st.watch || {});
  if (!e.length) return "Takip listen boş. Eklemek için: /takip SEMBOL";
  const L = ["👁 TAKİP LİSTESİ"];
  for (const [sym, w] of e) {
    const p = w.last;
    L.push(`• ${sym} · ${w.d}'den beri${p ? ` · $${w.px} → $${p} (${((p / w.px - 1) * 100).toFixed(1)}%)` : ""}` +
      (w.pick ? ` · seçim: ${w.pick}` : "") + (w.above200 === false ? " · 200g altında" : ""));
  }
  return L.join("\n");
}
