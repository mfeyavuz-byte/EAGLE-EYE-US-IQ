// SPOT SİNYAL KARNESİ + ÇIKIŞ PLANI
// Gönderilen her AL/SAT sinyali fiyatı, SPY'ı ve (AL için) stop/hedef seviyeleriyle kaydedilir.
// AL'ler için ÇIKIŞ kuralları (araştırmanın ölçtüğü ufukla aynı): stop kırıldı · hedefe ulaşıldı ·
// 21 işlem günü doldu → "📕 SPOT ÇIKIŞ" mesajı. SAT'lar zaten "çık/girme" demektir; 21 gün sonra ölçülüp kapanır.
// Karne: kapanmış sinyaller gerçekleşen sonuçla, açık olanlar güncel fiyatla.
export const MAX_SPOT = 600;
export const HOLD_DAYS = +(process.env.SPOT_HOLD || 21);

// İki tarih arasındaki işlem günü (hafta içi; resmî tatiller yok sayılır → en fazla 1-2 gün sapma)
export function tradingDays(from, to) {
  let n = 0;
  for (let t = Date.parse(from + "T12:00:00Z") + 864e5; t <= Date.parse(to + "T12:00:00Z"); t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export function logSignals(book, signals, date, spyPx) {
  for (const s of signals) {
    if (book.some(b => b.sym === s.sym && !b.closed && b.sig === s.signal)) continue;   // açık aynı sinyal varsa tekrar açma
    book.push({ sym: s.sym, sig: s.signal, d: date, px: s.price, spy: spyPx ?? null, conf: s.confidence,
      stop: s.stopLoss ?? null, tgt: s.target1 ?? null, size: s.sizePct ?? null });
  }
  if (book.length > MAX_SPOT) book.splice(0, book.length - MAX_SPOT);
}

// Çıkış kontrolü. price(sym) → güncel fiyat | null. Dönüş: bugün kapananlar.
export function checkExits(book, today, price, spyNow) {
  const out = [];
  for (const b of book) {
    if (b.closed) continue;
    const p = price(b.sym);
    if (!(p > 0)) continue;
    const td = tradingDays(b.d, today);
    let why = null;
    if (b.sig === "AL") {
      if (b.stop && p <= b.stop) why = "stop";
      else if (b.tgt && p >= b.tgt) why = "hedef";
      else if (td >= HOLD_DAYS) why = "süre";
    } else if (td >= HOLD_DAYS) why = "süre";
    if (!why) continue;
    const dir = b.sig === "SAT" ? -1 : 1, raw = p / b.px - 1, spyRet = b.spy && spyNow ? spyNow / b.spy - 1 : 0;
    b.closed = { d: today, px: p, why, td, ret: +(dir * raw).toFixed(4), ex: +(dir * (raw - spyRet)).toFixed(4) };
    out.push(b);
  }
  return out;
}

const pc = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
const WHY = { stop: "stop kırıldı", hedef: "hedefe ulaştı", "süre": "21 işlem günü doldu" };
export function fmtExits(list) {
  const al = list.filter(b => b.sig === "AL"), sat = list.filter(b => b.sig === "SAT");
  const L = [];
  if (al.length) {
    L.push("📕 SPOT ÇIKIŞ — AL pozisyonlarını kapat");
    for (const b of al) L.push(`${b.closed.ret >= 0 ? "✅" : "❌"} ${b.sym} · ${WHY[b.closed.why]} · giriş $${b.px} → $${b.closed.px} · ${pc(b.closed.ret)} · SPY'a göre ${pc(b.closed.ex)} · ${b.closed.td} gün`);
  }
  if (sat.length) {
    L.push(...(L.length ? [""] : []), "📗 SAT sinyallerinin 21 günlük sonucu (düşüş = doğru)");
    for (const b of sat) L.push(`${b.closed.ret >= 0 ? "✅" : "❌"} ${b.sym} · $${b.px} → $${b.closed.px} · sinyal yönünde ${pc(b.closed.ret)} · SPY'a göre ${pc(b.closed.ex)}`);
  }
  return L.join("\n");
}

// Karne satırları: kapanmışlar gerçekleşen, açıklar güncel fiyatla. Dönüş: { ...b, ret, ex, open }
export function score(book, price, spyNow) {
  const out = [];
  for (const b of book) {
    if (b.closed) { out.push({ ...b, ret: b.closed.ret, ex: b.closed.ex, open: false }); continue; }
    const p = price(b.sym);
    if (!(p > 0) || !(b.px > 0)) continue;
    const dir = b.sig === "SAT" ? -1 : 1;
    const raw = p / b.px - 1, spyRet = b.spy && spyNow ? spyNow / b.spy - 1 : 0;
    out.push({ ...b, now: p, ret: dir * raw, ex: dir * (raw - spyRet), open: true });
  }
  return out;
}

export function fmtSpotReport(scored, fromDate, title = "📈 SPOT SİNYAL KARNESİ") {
  const g = scored.filter(x => x.d >= fromDate);
  const L = [title + ` (${fromDate} sonrası)`];
  if (!g.length) return L.concat("Bu dönemde gönderilen sinyal yok.").join("\n");
  const avg = a => a.reduce((p, v) => p + v, 0) / a.length;
  for (const s of ["AL", "SAT"]) {
    const x = g.filter(v => v.sig === s);
    if (!x.length) continue;
    const c = x.filter(v => !v.open);
    L.push(`${s}: ${x.length} sinyal (kapanan ${c.length}) · sinyal yönünde ort. ${pc(avg(x.map(v => v.ret)))} · SPY'a göre ${pc(avg(x.map(v => v.ex)))} · isabet %${Math.round(x.filter(v => v.ret > 0).length / x.length * 100)}` +
      (c.length ? ` · kapananlar ${pc(avg(c.map(v => v.ret)))}` : ""));
  }
  const best = [...g].sort((a, b) => b.ex - a.ex).slice(0, 3), worst = [...g].sort((a, b) => a.ex - b.ex).slice(0, 3);
  L.push("En iyi: " + best.map(v => `${v.sym} ${v.sig} ${pc(v.ret)}`).join(" · "));
  L.push("En kötü: " + worst.map(v => `${v.sym} ${v.sig} ${pc(v.ret)}`).join(" · "));
  return L.join("\n");
}
