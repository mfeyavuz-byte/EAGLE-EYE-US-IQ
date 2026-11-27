// SENİN POZİSYONLARIN — "/aldim SPY 728C 4.50" ile eklenir; bot seans boyunca (~10 dk'da bir) izler ve TEK SEFERLİK uyarı atar:
//   🛑 prim −%50 · ✅ prim +%100 · 🎯/🛑 dayanak hedef/stop (girdiysen) · ⏰ vade bugün, kapanışa ≤ 30 dk · ⏰ vadeye 1 gün.
// Komutlar: /aldim SEMBOL STRIKE(C|P) [VADE gg.aa] FİYAT [ADET] [hedef X] [stop Y] · /sattim SEMBOL STRIKE(C|P) [FİYAT] · /pozisyonlarim
export const MP = { SL: -0.5, TP: 1.0, EXP_WARN_MIN: 30 };

// Tarih: "04.12" / "4.12" / "12-04" / "2026-12-04" → ISO (yıl: bugünden sonraki ilk uygun)
export function parseExp(tok, today) {
  let m, y = +today.slice(0, 4), mo, d;
  if ((m = tok.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return tok;
  if ((m = tok.match(/^(\d{1,2})\.(\d{1,2})$/))) { d = +m[1]; mo = +m[2]; }
  else if ((m = tok.match(/^(\d{1,2})-(\d{1,2})$/))) { mo = +m[1]; d = +m[2]; }
  else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  let iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (iso < today) iso = `${y + 1}${iso.slice(4)}`;
  return iso;
}

// args: ["SPY","728C","04.12","4.50","2","hedef","730","stop","725"] → poz | { err }
export function parseBuy(args, today) {
  const a = [...(args || [])];
  const sym = String(a.shift() || "").toUpperCase().replace(/[^A-Z.]/g, "");
  let kt = String(a.shift() || "").toUpperCase();
  if (/^\d+(\.\d+)?$/.test(kt) && /^[CP]$/i.test(a[0] || "")) kt += String(a.shift()).toUpperCase();   // "728 C"
  const km = kt.match(/^(\d+(?:\.\d+)?)([CP])$/);
  if (!sym || !km) return { err: "Kullanım: /aldim SEMBOL STRIKE+C/P [VADE gg.aa] FİYAT [ADET] [hedef X] [stop Y]\nÖrn: /aldim SPY 728C 4.50 · /aldim NVDA 185P 05.12 3.20 2 stop 190" };
  const pos = { sym, K: +km[1], type: km[2], exp: null, px: null, qty: 1, tgtU: null, stopU: null };
  const raw = [];
  for (let i = 0; i < a.length; i++) {
    const t = String(a[i]).toLowerCase();
    if (t === "hedef" && a[i + 1]) { pos.tgtU = +a[++i]; continue; }
    if (t === "stop" && a[i + 1]) { pos.stopU = +a[++i]; continue; }
    raw.push(String(a[i]));
  }
  // Vade: "12-04" / "2026-12-04" her zaman tarih; "04.12" yalnız ardından fiyat geliyorsa (tek sayı = fiyat)
  if (raw.length && (/-/.test(raw[0]) || (raw.length >= 2 && /^\d{1,2}\.\d{1,2}$/.test(raw[0])))) {
    const e = parseExp(raw[0], today);
    if (e) { pos.exp = e; raw.shift(); }
  }
  const nums = raw.map(x => +x.replace(",", "."));
  pos.px = nums[0]; if (nums[1] >= 1) pos.qty = Math.floor(nums[1]);
  if (!(pos.px > 0)) return { err: "Alış fiyatını (prim) yaz. Örn: /aldim SPY 728C 4.50" };
  return pos;
}

// Saf karar: { mid (opsiyon), S (dayanak), toCloseMin, today } → yeni uyarılar [{ key, text }]
export function checkPos(p, { mid, S, toCloseMin = 999, today }) {
  const out = [], al = p.alerts || {}, name = `${p.sym} ${p.K}${p.type}${p.exp ? " " + p.exp.slice(8, 10) + "." + p.exp.slice(5, 7) : ""}`;
  const ret = mid > 0 ? mid / p.px - 1 : null, rt = ret != null ? `prim ${ret >= 0 ? "+" : "−"}%${Math.abs(Math.round(ret * 100))} ($${mid.toFixed(2)}, giriş $${p.px})` : "";
  if (ret != null && ret <= MP.SL && !al.sl) out.push({ key: "sl", text: `🛑 ${name} — ${rt} → KAPAT` });
  if (ret != null && ret >= MP.TP && !al.tp) out.push({ key: "tp", text: `✅ ${name} — ${rt} → en az yarısını sat` });
  if (S > 0 && p.tgtU && !al.tu && (p.type === "C" ? S >= p.tgtU : S <= p.tgtU)) out.push({ key: "tu", text: `🎯 ${name} — ${p.sym} hedefe geldi (${S.toFixed(2)}) ${rt} → KAPAT` });
  if (S > 0 && p.stopU && !al.su && (p.type === "C" ? S <= p.stopU : S >= p.stopU)) out.push({ key: "su", text: `🛑 ${name} — ${p.sym} stopta (${S.toFixed(2)}) ${rt} → KAPAT` });
  if (p.exp === today && toCloseMin <= MP.EXP_WARN_MIN && !al.ex) out.push({ key: "ex", text: `⏰ ${name} — vade BUGÜN, kapanışa ${Math.max(0, Math.round(toCloseMin))} dk${rt ? " · " + rt : ""} → kapat ya da değersiz bitebilir` });
  return out;
}

export function fmtPositions(list, vals = {}) {
  if (!list?.length) return "📌 Takipte pozisyon yok. Eklemek için: /aldim SPY 728C 4.50";
  return ["📌 Pozisyonların", ...list.map(p => {
    const v = vals[p.id], r = v > 0 ? v / p.px - 1 : null;
    return `${p.sym} ${p.K}${p.type} ${p.exp ? p.exp.slice(8, 10) + "." + p.exp.slice(5, 7) : ""} ×${p.qty} · giriş $${p.px}${v > 0 ? ` · şimdi $${v.toFixed(2)} (${r >= 0 ? "+" : "−"}%${Math.abs(Math.round(r * 100))}, ${r >= 0 ? "+" : "−"}$${Math.abs(Math.round((v - p.px) * 100 * p.qty))})` : ""}`;
  })].join("\n");
}
