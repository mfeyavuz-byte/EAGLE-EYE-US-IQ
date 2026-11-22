// OPSİYON KARNESİ — modelin dürüstlük ölçüsü. Her fikir iki ayrı şekilde ölçülür:
//
// 1) GERÇEKÇİ (yönetilmiş): Fikir açık kaldığı sürece her gün (15:00 NY sonrası) bacakların CANLI alış/satış
//    fiyatlarıyla değerlenir ve mesajdaki yönetim kuralları (kâr al · zarar durdur · süre · kısa strike) aynen
//    uygulanır. Kapanış fiyatı = orta − %30·spread (bizim aleyhimize), yani gerçekten kapatan birinin sonucu.
// 2) VADEYE KADAR TUTULMUŞ: dayanağın vade günü kapanışıyla. Modelin EV/POP tahmini vade tanımlı olduğu için
//    kalibrasyon (tahmin ≈ gerçekleşen mi?) bununla yapılır.
import { payoffAt } from "./dist.mjs";
import { SLIP } from "./strategies.mjs";

export const MAX_BOOK = 400;
const DAY = 864e5;
const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const sprPct = l => (l.bid > 0 && l.ask > 0 ? +((l.ask - l.bid) / ((l.ask + l.bid) / 2)).toFixed(3) : null);

export function addIdeas(book, ideas, date) {
  for (const { sym, idea: i } of ideas) {
    const id = `${sym}|${i.code}|${i.expDate}|${i.legs.map(l => l.side + l.type + l.K).join(",")}`;
    if (book.some(b => b.id === id)) continue;                         // aynı fikir tekrar kaydedilmez
    book.push({
      id, date, sym, code: i.code, kind: i.kind, exp: i.expDate, debit: +i.debit.toFixed(4),
      legs: i.legs.map(l => ({ type: l.type, K: l.K, side: l.side, occ: l.sym || null, sp: sprPct(l) })),
      ev: Math.round(i.ev), pop: +i.pop.toFixed(3), popMkt: +i.popMkt.toFixed(3),
      maxLoss: Math.round(i.maxLoss), maxProfit: isFinite(i.maxProfit) ? Math.round(i.maxProfit) : null,
      rules: i.rules || null,
    });
  }
  if (book.length > MAX_BOOK) book.splice(0, book.length - MAX_BOOK);
}

// Bacağın bugünkü kotasyonu. Önce kontrat sembolüyle, yoksa tip + strike ile eşleşir.
function quoteFor(leg, ch) {
  const arr = leg.type === "C" ? ch.calls : ch.puts;
  return arr.find(o => leg.occ && o.sym === leg.occ) || arr.find(o => Math.abs(o.strike - leg.K) < 1e-6) || null;
}

// Pozisyonu bugün kapatsak eline geçecek değer (hisse başına) | null (güvenilir kotasyon yoksa).
// Alıştaki bacak orta − %30·spread'den satılır, satıştaki bacak orta + %30·spread'den geri alınır.
export function exitValue(legs, ch) {
  let v = 0;
  for (const l of legs) {
    const q = quoteFor(l, ch);
    if (!q) return null;
    let bid = q.bid || 0, ask = q.ask || 0;
    if (!bid && !ask) {
      // Kotasyon yok: yalnızca derin OTM ise değersiz say; aksi halde bugün değerleme yapma.
      const otm = l.type === "C" ? ch.S < l.K * 0.97 : ch.S > l.K * 1.03;
      if (!otm) return null;
    } else if (!bid) bid = 0;
    else if (!ask) return null;
    const mid = (bid + ask) / 2;
    v += l.side * (mid - l.side * SLIP * (ask - bid));
  }
  return v;
}

// Kural kontrolü — sıra: zarar durdur, kısa strike, kâr al, süre.
export function checkRules(b, pnl, S, dteLeft) {
  const r = b.rules;
  if (!r) return dteLeft <= 0 ? "vade" : null;
  if (r.sl != null && pnl <= r.sl) return "zarar durdur";
  if (r.breakShort && S != null) {
    const broke = b.legs.some(l => l.side < 0 && (l.type === "P" ? S < l.K : S > l.K));
    if (broke) return "kısa strike kırıldı";
  }
  if (r.tp != null && pnl >= r.tp) return "kâr hedefi";
  if (dteLeft <= r.dte) return "süre";
  return null;
}

// Günlük değerleme. getChain(sym, expTs) → { S, calls:[{strike,bid,ask,sym}], puts:[…] } | null.
// Dönüş: { marked, closed:[kurala göre bugün kapananlar] }
export async function markBook(book, today, getChain) {
  const open = book.filter(b => !b.closed && !b.settled && b.date < today && b.exp > today);
  const groups = new Map();
  for (const b of open) {
    const k = `${b.sym}|${b.exp}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  let marked = 0;
  const closed = [];
  for (const [k, list] of groups) {
    const [sym, exp] = k.split("|");
    const ch = await getChain(sym, Date.parse(exp + "T00:00:00Z") / 1e3).catch(() => null);
    if (!ch) continue;
    for (const b of list) {
      const v = exitValue(b.legs, ch);
      if (v == null) continue;
      const pnl = Math.round((v - b.debit) * 100);
      b.mark = { d: today, pnl, S: ch.S != null ? +(+ch.S).toFixed(2) : null };
      b.hi = Math.max(b.hi ?? pnl, pnl); b.lo = Math.min(b.lo ?? pnl, pnl); b.nm = (b.nm || 0) + 1;
      marked++;
      const reason = checkRules(b, pnl, ch.S, days(today, b.exp));
      if (reason) { b.closed = { d: today, pnl, reason, days: days(b.date, today) }; closed.push(b); }
    }
  }
  return { marked, closed };
}

// Vadeye kadar tutulmuş sonuç. closeOn(sym, expDate) → o günün (yoksa öncesindeki son) kapanışı | null.
// Kurallarla kapanmamış (değerleme verisi eksik kalmış) fikirlerin gerçekçi sonucu da bununla tamamlanır.
export async function settle(book, today, closeOn) {
  const done = [];
  for (const b of book) {
    if (b.settled || b.exp >= today) continue;
    const px = await closeOn(b.sym, b.exp);
    if (px == null) continue;
    b.close = px;
    b.pnl = Math.round((payoffAt(b.legs, px) - b.debit) * 100);
    b.settled = true;
    if (!b.closed) b.closed = { d: b.exp, pnl: b.pnl, reason: "vade", days: days(b.date, b.exp) };
    done.push(b);
  }
  return done;
}

export function stats(book) {
  const sum = (a, f) => a.reduce((x, b) => x + f(b), 0);
  // Vadeye kadar tutulmuş (kalibrasyon)
  const s = book.filter(b => b.settled), n = s.length;
  const by = {};
  for (const b of s) {
    const g = by[b.code] || (by[b.code] = { n: 0, w: 0, pnl: 0, ev: 0, pop: 0 });
    g.n++; g.w += b.pnl > 0 ? 1 : 0; g.pnl += b.pnl; g.ev += b.ev; g.pop += b.pop;
  }
  // Gerçekçi (yönetilmiş)
  const c = book.filter(b => b.closed), nc = c.length;
  const reasons = {};
  for (const b of c) reasons[b.closed.reason] = (reasons[b.closed.reason] || 0) + 1;
  const open = book.filter(b => !b.closed);
  return {
    n, open: open.length,
    winRate: n ? sum(s, b => (b.pnl > 0 ? 1 : 0)) / n : null,
    predPop: n ? sum(s, b => b.pop) / n : null, mktPop: n ? sum(s, b => b.popMkt) / n : null,
    pnl: sum(s, b => b.pnl), predEv: sum(s, b => b.ev), risk: sum(s, b => b.maxLoss), by,
    real: {
      n: nc, winRate: nc ? sum(c, b => (b.closed.pnl > 0 ? 1 : 0)) / nc : null,
      pnl: sum(c, b => b.closed.pnl), risk: sum(c, b => b.maxLoss),
      avgDays: nc ? sum(c, b => b.closed.days || 0) / nc : null, reasons,
      // aynı fikirlerin vadeye kadar tutulmuş hali (yönetimin katkısı = gerçekçi − bu)
      holdPnl: sum(c.filter(b => b.settled), b => b.pnl), holdN: c.filter(b => b.settled).length,
      holdPnlSame: sum(c.filter(b => b.settled), b => b.closed.pnl),
    },
    openPnl: sum(open.filter(b => b.mark), b => b.mark.pnl), openMarked: open.filter(b => b.mark).length,
  };
}

const sg = v => (v >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US");
const p = v => (v * 100).toFixed(0) + "%";

export function fmtStats(st) {
  const L = ["📒 OPSİYON KARNESİ"];
  const R = st.real || { n: 0 };
  if (!R.n && !st.n) {
    L.push(`Henüz kapanan fikir yok (açık: ${st.open}${st.openMarked ? `, güncel K/Z ${sg(st.openPnl)}` : ""}).`,
      "Açık fikirler her gün canlı fiyatla değerlenir; kural tetiklenince Telegram'dan haber gelir.");
    return L.join("\n");
  }
  if (R.n) {
    L.push("", "▶ GERÇEKÇİ (mesajdaki yönetim kurallarıyla, canlı alış/satış fiyatından)",
      `Kapanan ${R.n} · kazanma oranı ${p(R.winRate)} · ort. ${R.avgDays.toFixed(0)} gün`,
      `Toplam K/Z ${sg(R.pnl)} · riske edilen $${R.risk.toLocaleString("en-US")} · getiri/risk ${(R.pnl / Math.max(1, R.risk) * 100).toFixed(1)}%`,
      `Kapanış nedenleri: ${Object.entries(R.reasons).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (R.holdN) L.push(`Yönetimin katkısı (vadesi gelen ${R.holdN} fikirde): kurallarla ${sg(R.holdPnlSame)} vs vadeye kadar tutsan ${sg(R.holdPnl)}`);
  }
  if (st.open) L.push(`Açık ${st.open}${st.openMarked ? ` · güncel K/Z ${sg(st.openPnl)}` : ""}`);
  if (st.n) {
    L.push("", "▶ MODEL KALİBRASYONU (vadeye kadar tutulmuş varsayımıyla)",
      `Sonuçlanan ${st.n} · kazanma oranı ${p(st.winRate)} · modelin tahmini ${p(st.predPop)} · piyasanın ${p(st.mktPop)}`,
      `Toplam K/Z ${sg(st.pnl)} · modelin tahmini EV ${sg(st.predEv)}`,
      ...Object.entries(st.by).map(([k, g]) => `• ${k}: ${g.n} işlem · kazanan ${g.w} (tahmin ${p(g.pop / g.n)}) · K/Z ${sg(g.pnl)} (EV tahmini ${sg(g.ev)})`),
      st.n < 30 ? "ℹ 30 işlemden az — istatistik henüz güvenilir değil."
        : (st.winRate < st.predPop - 0.08 ? "⚠ Model kazanma oranını abartıyor → eğimi/oynaklık avantajını düşürmek gerekebilir." : "✓ Tahmin ile gerçekleşen uyumlu."));
  }
  return L.join("\n");
}

// Kurala göre kapanan fikirler için Telegram satırı.
export function fmtClosed(b) {
  const c = b.closed;
  return `${c.pnl >= 0 ? "✅" : "❌"} ${b.sym} ${b.code} (${b.exp}) · ${c.reason} · ${c.days} gün · K/Z ${sg(c.pnl)}` +
    (b.mark?.S ? ` · dayanak $${b.mark.S}` : "");
}
