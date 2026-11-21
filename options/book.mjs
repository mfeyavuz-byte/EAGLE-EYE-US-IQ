// OPSİYON KARNESİ — modelin dürüstlük ölçüsü.
// Gönderilen her fikir kaydedilir; vade geçince dayanak hissenin vade günü kapanışıyla VADEYE KADAR TUTULMUŞ
// gibi sonuçlandırılır (yönetim kuralları uygulanmaz → modelin vade tanımlı EV/POP tahminiyle birebir kıyas).
// Kalibrasyon: gerçekleşen kazanma oranı ≈ ort. tahmini POP mu? Toplam K/Z ≈ toplam tahmini EV mi?
import { payoffAt } from "./dist.mjs";

export const MAX_BOOK = 400;

export function addIdeas(book, ideas, date) {
  for (const { sym, idea: i } of ideas) {
    const id = `${sym}|${i.code}|${i.expDate}|${i.legs.map(l => l.side + l.type + l.K).join(",")}`;
    if (book.some(b => b.id === id)) continue;                         // aynı fikir tekrar kaydedilmez
    book.push({
      id, date, sym, code: i.code, exp: i.expDate, debit: +i.debit.toFixed(4),
      legs: i.legs.map(l => ({ type: l.type, K: l.K, side: l.side })),
      ev: Math.round(i.ev), pop: +i.pop.toFixed(3), popMkt: +i.popMkt.toFixed(3), maxLoss: Math.round(i.maxLoss),
    });
  }
  if (book.length > MAX_BOOK) book.splice(0, book.length - MAX_BOOK);
}

// closeOn(sym, expDate) → o günün (yoksa öncesindeki son) kapanışı | null. Dönüş: yeni sonuçlananlar.
export async function settle(book, today, closeOn) {
  const done = [];
  for (const b of book) {
    if (b.settled || b.exp >= today) continue;
    const px = await closeOn(b.sym, b.exp);
    if (px == null) continue;
    b.close = px;
    b.pnl = Math.round((payoffAt(b.legs, px) - b.debit) * 100);
    b.settled = true;
    done.push(b);
  }
  return done;
}

export function stats(book) {
  const s = book.filter(b => b.settled), n = s.length;
  const sum = (a, f) => a.reduce((x, b) => x + f(b), 0);
  const by = {};
  for (const b of s) {
    const g = by[b.code] || (by[b.code] = { n: 0, w: 0, pnl: 0, ev: 0, pop: 0 });
    g.n++; g.w += b.pnl > 0 ? 1 : 0; g.pnl += b.pnl; g.ev += b.ev; g.pop += b.pop;
  }
  return {
    n, open: book.length - n,
    winRate: n ? sum(s, b => (b.pnl > 0 ? 1 : 0)) / n : null,
    predPop: n ? sum(s, b => b.pop) / n : null, mktPop: n ? sum(s, b => b.popMkt) / n : null,
    pnl: sum(s, b => b.pnl), predEv: sum(s, b => b.ev), risk: sum(s, b => b.maxLoss), by,
  };
}

export function fmtStats(st) {
  if (!st.n) return `📒 OPSİYON KARNESİ\nHenüz vadesi dolan fikir yok (açık: ${st.open}). İlk sonuçlar en erken ~3-4 hafta sonra.`;
  const p = v => (v * 100).toFixed(0) + "%";
  const L = [
    "📒 OPSİYON KARNESİ (vadeye kadar tutulmuş varsayımıyla)",
    `Sonuçlanan ${st.n} · açık ${st.open}`,
    `Kazanma oranı ${p(st.winRate)} · modelin tahmini ${p(st.predPop)} · piyasanın ${p(st.mktPop)}`,
    `Toplam K/Z ${st.pnl >= 0 ? "+" : ""}$${st.pnl} · modelin tahmini EV +$${st.predEv} · riske edilen $${st.risk}`,
    `Getiri/risk ${(st.pnl / Math.max(1, st.risk) * 100).toFixed(1)}%`,
    "",
    ...Object.entries(st.by).map(([k, g]) => `• ${k}: ${g.n} işlem · kazanan ${g.w} (tahmin ${p(g.pop / g.n)}) · K/Z ${g.pnl >= 0 ? "+" : ""}$${g.pnl} (EV tahmini +$${g.ev})`),
    "",
    st.n < 30 ? "ℹ 30 işlemden az — istatistik henüz güvenilir değil." : (st.winRate < st.predPop - 0.08 ? "⚠ Model kazanma oranını abartıyor → eğimi/oynaklık avantajını düşürmek gerekebilir." : "✓ Tahmin ile gerçekleşen uyumlu."),
  ];
  return L.join("\n");
}
