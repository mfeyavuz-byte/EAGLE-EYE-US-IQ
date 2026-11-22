// MODEL PORTFÖY (sanal, Alpaca gerektirmez) — spot AL seçimlerini kurallı bir portföy olarak yürütür ve SPY ile kıyaslar.
// Kurallar:
//  • Başlangıç sermayesi MODEL_CAPITAL ($100.000) · en çok MODEL_SLOTS (15) pozisyon · eşit ağırlık: girişte
//    özsermaye / slot sayısı (nakit yetmezse kalan nakit) · boş slot yoksa yeni AL alınmaz (kalite sırası korunur).
//  • Çıkış: spot kuralıyla aynı — stop kırılınca, hedefe ulaşınca ya da 21 işlem günü dolunca (tarama fiyatıyla).
//  • İşlem maliyeti: her alış ve satışta %0.05 (kayma). Nakit faiz getirmez (temkinli).
//  • Günde bir özsermaye + SPY kaydı → dönem getirisi, SPY farkı, en büyük düşüş.
import { tradingDays } from "./spotbook.mjs";

export const MCFG = {
  CAPITAL: +(process.env.MODEL_CAPITAL || 100000),
  SLOTS: +(process.env.MODEL_SLOTS || 15),
  COST: 0.0005,
  HOLD: +(process.env.SPOT_HOLD || 21),
};

export function initModel(today, spyPx) {
  const mon = +today.slice(5, 7);
  return { start: { d: today, eq: MCFG.CAPITAL, spy: spyPx ?? null }, cash: MCFG.CAPITAL, pos: {}, closed: [], hist: [],
    lastMonthly: today.slice(0, 7), lastQuarterly: `${today.slice(0, 4)}-Q${Math.ceil(mon / 3)}` };
}

export function equity(m, priceOf) {
  let v = m.cash;
  for (const [s, p] of Object.entries(m.pos)) v += p.sh * (priceOf(s) ?? p.last ?? p.px);
  return v;
}

// Bir tarama turu: önce çıkışlar, sonra yeni AL'ler, sonra (günde 1) özsermaye kaydı.
// als: bu turda gönderilen AL sinyalleri (kalite sırasıyla) · priceOf(sym) → tarama fiyatı | undefined
// Dönüş: { bought:[...], sold:[...] }
export function stepModel(m, today, als, priceOf, spyPx) {
  const sold = [], bought = [];
  for (const [s, p] of Object.entries(m.pos)) {
    const px = priceOf(s);
    if (!(px > 0)) continue;
    p.last = px;
    const td = tradingDays(p.d, today);
    const why = p.stop && px <= p.stop ? "stop" : p.tgt && px >= p.tgt ? "hedef" : td >= MCFG.HOLD ? "süre" : null;
    if (!why) continue;
    const proceeds = p.sh * px * (1 - MCFG.COST);
    m.cash += proceeds;
    const rec = { sym: s, d: p.d, exitD: today, px: p.px, exitPx: px, ret: +(proceeds / p.cost - 1).toFixed(4), pnl: Math.round(proceeds - p.cost), why, td };
    m.closed.push(rec); sold.push(rec); delete m.pos[s];
  }
  if (m.closed.length > 500) m.closed.splice(0, m.closed.length - 500);
  for (const a of als || []) {
    if (m.pos[a.sym] || Object.keys(m.pos).length >= MCFG.SLOTS || !(a.price > 0)) continue;
    const eq = equity(m, priceOf), alloc = Math.min(eq / MCFG.SLOTS, m.cash);
    if (alloc < 100) break;                                       // nakit kalmadı
    const sh = alloc * (1 - MCFG.COST) / a.price;
    m.cash -= alloc;
    m.pos[a.sym] = { d: today, px: a.price, sh, cost: alloc, stop: a.stopLoss ?? null, tgt: a.target1 ?? null, last: a.price };
    bought.push({ sym: a.sym, px: a.price, alloc: Math.round(alloc) });
  }
  const last = m.hist.at(-1);
  const snap = { d: today, eq: Math.round(equity(m, priceOf)), spy: spyPx ?? last?.spy ?? null };
  if (last?.d === today) m.hist[m.hist.length - 1] = snap; else m.hist.push(snap);
  if (m.hist.length > 800) m.hist.splice(0, m.hist.length - 800);
  return { bought, sold };
}

// Dönem özeti: fromD (dahil değil: o tarihteki kapanış başlangıç kabul edilir) → son kayıt
export function periodStats(m, fromD, toD = null) {
  const h = toD ? m.hist.filter(x => x.d <= toD) : m.hist;
  if (!h.length) return null;
  // Başlangıç noktası: fromD'deki (ya da öncesindeki son) kayıt; yoksa portföyün başlangıç sermayesi
  const base = [...h].reverse().find(x => x.d <= fromD && x.d !== m.start.d) || { d: m.start.d, eq: m.start.eq, spy: m.start.spy ?? h[0].spy }, end = h.at(-1);
  const seg = h.filter(x => x.d >= base.d);
  let peak = base.eq, mdd = 0;                                    // başlangıç noktası da tepe adayı
  for (const x of seg) { peak = Math.max(peak, x.eq); mdd = Math.min(mdd, x.eq / peak - 1); }
  const trades = m.closed.filter(t => t.exitD > base.d && t.exitD <= end.d);
  return {
    from: base.d, to: end.d, ret: end.eq / base.eq - 1, spyRet: base.spy && end.spy ? end.spy / base.spy - 1 : null,
    mdd, eq: end.eq, n: trades.length, wins: trades.filter(t => t.ret > 0).length,
    best: [...trades].sort((a, b) => b.ret - a.ret)[0] || null, worst: [...trades].sort((a, b) => a.ret - b.ret)[0] || null,
  };
}

const pc = v => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
const usd = v => "$" + Math.round(v).toLocaleString("en-US");

export function fmtModel(m, title, fromD, priceOf = () => undefined, toD = null) {
  const s = periodStats(m, fromD, toD);
  if (!s) return `${title}\nHenüz kayıt yok (model portföy ilk tarama gününden itibaren işler).`;
  const all = periodStats(m, m.start.d);
  const L = [title, `Dönem ${s.from} → ${s.to}`,
    `Getiri ${pc(s.ret)} · SPY ${pc(s.spyRet)} · fark ${s.spyRet != null ? pc(s.ret - s.spyRet) : "—"} · en büyük düşüş ${s.mdd < 0 ? pc(s.mdd) : "%0.00"}`,
    `Özsermaye ${usd(s.eq)} · başlangıçtan (${m.start.d}) ${pc(all.ret)} (SPY ${pc(all.spyRet)})`,
    `Kapanan işlem ${s.n}${s.n ? ` · kazanan %${Math.round(s.wins / s.n * 100)}` : ""}` +
      (s.best ? ` · en iyi ${s.best.sym} ${pc(s.best.ret)}` : "") + (s.worst ? ` · en kötü ${s.worst.sym} ${pc(s.worst.ret)}` : "")];
  const pos = Object.entries(m.pos);
  L.push(`Açık pozisyon ${pos.length}/${MCFG.SLOTS} · nakit ${usd(m.cash)}`);
  for (const [sym, p] of pos.slice(0, 15)) {
    const px = priceOf(sym) ?? p.last ?? p.px;
    L.push(`• ${sym} ${p.d} $${p.px} → $${(+px).toFixed(2)} (${pc(px * p.sh / p.cost - 1)})`);
  }
  L.push("ℹ Sanal portföy: AL seçimleri, eşit ağırlık, en çok 15 pozisyon, stop/hedef/21 gün çıkış, %0.05 maliyet. ⚠ Yatırım tavsiyesi değildir.");
  return L.join("\n");
}

// Rapor zamanları: aylık = yeni ayın ilk işlem günü, 3 aylık = Ocak/Nisan/Temmuz/Ekim'in ilk işlem günü (önceki dönemi özetler)
export function dueReports(m, today) {
  const ym = today.slice(0, 7), mon = +today.slice(5, 7), q = `${today.slice(0, 4)}-Q${Math.ceil(mon / 3)}`;
  const out = [];
  if (m.lastMonthly && m.lastMonthly !== ym) out.push("monthly");
  if (m.lastQuarterly && m.lastQuarterly !== q && [1, 4, 7, 10].includes(mon)) out.push("quarterly");
  return { out, ym, q };
}
export const monthStart = d => d.slice(0, 7) + "-01";
export function prevMonthEnd(d) { const t = Date.parse(monthStart(d) + "T12:00:00Z") - 864e5; return new Date(t).toISOString().slice(0, 10); }
export function prevQuarterEnd(d) { const mon = +d.slice(5, 7), qStartMon = Math.floor((mon - 1) / 3) * 3 + 1; const t = Date.parse(`${d.slice(0, 4)}-${String(qStartMon).padStart(2, "0")}-01T12:00:00Z`) - 864e5; return new Date(t).toISOString().slice(0, 10); }
export const shiftDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
