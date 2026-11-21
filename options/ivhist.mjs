// IV30 geçmişi — IV rank/yüzdelik için. Ücretsiz kaynak IV geçmişi vermediğinden kendimiz biriktiriyoruz:
// her işlem günü seans sonuna doğru likit opsiyonlu hisselerin IV30'u kaydedilir (en çok 252 gün).
// Biçim (yer tasarrufu): { SYM: { d: "YYYY-MM-DD" (son kayıt), v: [binde tamsayı IV, ...] } }
import { loadChain } from "./chain.mjs";
import { volDashboard } from "./vol.mjs";

export const MAX_DAYS = 252;

export function histOf(store, sym) {
  const h = store?.[sym];
  return h?.v?.length ? h.v.map(x => x / 1000) : null;
}

export function record(store, sym, date, iv) {
  if (!iv || !isFinite(iv)) return;
  const h = store[sym] || (store[sym] = { d: "", v: [] });
  const val = Math.round(iv * 1000);
  if (h.d === date) h.v[h.v.length - 1] = val;        // aynı gün → güncelle
  else { h.v.push(val); h.d = date; }
  if (h.v.length > MAX_DAYS) h.v.splice(0, h.v.length - MAX_DAYS);
}

// Toplu anlık görüntü: yalnız analiz vadeleri (ön + ~30g) → sembol başına 2 istek.
export async function snapshot(store, syms, date, r, conc = 5) {
  let ok = 0;
  for (let i = 0; i < syms.length; i += conc) {
    await Promise.all(syms.slice(i, i + conc).map(async s => {
      try {
        const ch = await loadChain(s, r, { analyticsOnly: true });
        if (!ch) return;
        const v = volDashboard(ch, [], null);
        if (v.iv30) { record(store, s, date, v.iv30); ok++; }
      } catch {}
    }));
  }
  return ok;
}
