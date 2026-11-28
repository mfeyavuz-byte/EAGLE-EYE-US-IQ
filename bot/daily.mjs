// Günlük kısa mesajlar: açılış öncesi en çok açılanlar ve gün sonu tek satır karne.

// q: { SYM: { price, ts, prev } } (Alpaca IEX ön piyasa son işlem + dünkü kapanış) → en çok açılan n (|boşluk| ≥ %3, son 30 dk işlem)
export function pmMovers(q, now = Date.now(), n = 8) {
  const xs = [];
  for (const [sym, v] of Object.entries(q || {})) {
    if (!(v?.price >= 10) || !(v.prev > 0) || !v.ts || now - v.ts > 30 * 60e3) continue;
    const gap = v.price / v.prev - 1;
    if (Math.abs(gap) < 0.03) continue;
    // Plan: boşluk yönünde devam — giriş fiyatın %0.2 ötesi, R = max(boşluğun %25'i, fiyatın %0.5'i), hedef 2R
    const S = v.price, R = Math.max(Math.abs(S - v.prev) * 0.25, S * 0.005), up = gap > 0, e = up ? S * 1.002 : S * 0.998;
    xs.push({ sym, S, gap, dir: up ? "C" : "P", entry: +e.toFixed(2), stop: +(up ? e - R : e + R).toFixed(2), target: +(up ? e + 2 * R : e - 2 * R).toFixed(2) });
  }
  return xs.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, n);
}
export function fmtPmMovers(list) {
  return ["🌅 AÇILIŞ ÖNCESİ HAREKETLİLER", ...list.map(x =>
    `${x.gap > 0 ? "↑" : "↓"} ${x.sym} ${x.gap > 0 ? "+" : "−"}%${Math.abs(x.gap * 100).toFixed(1)} ${x.S.toFixed(2)} · ${x.dir === "C" ? "CALL >" : "PUT <"}${x.entry} h${x.target} s${x.stop}${x.news ? ` · ${x.news.slice(0, 60)}${x.news.length > 60 ? "…" : ""}` : ""}`)].join("\n");
}

// Gün sonu: bugünkü (ani hareket + kurulum) fikirlerinin sonucu + sanal hesap — tek mesaj, 1–2 satır
export function fmtEod(ideas, paper) {
  const done = ideas.filter(i => i.res && i.res !== "geçersiz"), k = r => done.filter(i => i.res === r).length;
  const netR = done.reduce((a, i) => a + (i.r || 0), 0), open = ideas.length - done.length;
  const L = [ideas.length ? `📒 Gün sonu: ${ideas.length} fikir · 🎯 ${k("HEDEF")} hedef · 🛑 ${k("STOP")} stop · ⏱ ${k("SÜRE")} süre · net ${netR >= 0 ? "+" : ""}${netR.toFixed(1)}R${open ? ` · ${open} sonuçlanmadı` : ""}`
    : "📒 Gün sonu: bugün ölçülmüş fikir yoktu."];
  if (paper?.n) L.push(`🧾 Sanal hesap: ${paper.n} işlem · net ${paper.pnl >= 0 ? "+" : "−"}$${Math.abs(Math.round(paper.pnl))}`);
  return L.join("\n");
}
