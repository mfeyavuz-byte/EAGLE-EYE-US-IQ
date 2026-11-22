// OPSİYON MODEL PORTFÖYLERİ (sanal, yalnız ALIM) — üç vade kolu, her biri $25.000 (SPY/QQQ kontratı ~$1.5–3k):
//   W  HAFTALIK  : vade 4–10 gün,  delta ≈ 0.50 · kaynak: sabah SPY/QQQ CALL çağrıları      · çıkış: vadeden ~1 işlem günü önce
//   M  AYLIK     : vade 35–50 gün, delta ≈ 0.60 · kaynak: ETF fırsatları (RSI2 call, korku call, put) · çıkış: vadeye 21 gün kala
//   Q  3 AYLIK   : vade 80–110 gün, delta ≈ 0.60 · kaynak: günün en iyi 2 spot AL'i (call) + en iyi SAT'ı (put) · çıkış: vadeye 30 gün kala
// Ortak: pozisyon başına kolun özsermayesinin %10'u (tek kontrat bunu aşarsa kolun %20'sine kadar 1 kontrat), en çok 8 açık,
// giriş orta + %30 spread, çıkış orta − %30 spread,
// zarar durdurma prim −%50, KÂR HEDEFİ YOK (opsiyon testi #4). Günde 1 kez (15:00 NY sonrası) canlı zincirle değerleme.
export const SLEEVES = {
  W: { lab: "Haftalık", lo: 4, hi: 10, delta: 0.5, exitDte: 1.5 },   // 1.5: Cuma vadesi Perşembe 15:00 NY değerlemesinde kapanır
  M: { lab: "Aylık", lo: 35, hi: 50, delta: 0.6, exitDte: 21 },
  Q: { lab: "3 aylık", lo: 80, hi: 110, delta: 0.6, exitDte: 30, daily: { C: 2, P: 1 } },   // adaylar sırayla; likit olanlardan günde en çok 2 call + 1 put
};
export const OMCFG = { CAP: +(process.env.OPT_MODEL_CAP || 25000), PCT: 0.10, MIN1_PCT: 0.20, MAXPOS: 8, SL: -0.5, SLIP: 0.3 };
const DAY = 864e5;
const dteLeft = (expTs, nowMs) => (expTs * 1e3 + 20 * 3600e3 - nowMs) / DAY;

export function initOptModel(today) {
  const sl = {};
  for (const k of Object.keys(SLEEVES)) sl[k] = { cash: OMCFG.CAP, pos: [], closed: [], hist: [] };
  return { start: today, sleeves: sl, pending: [] };
}

// Sinyal kuyruğu: { sleeve, sym, type, src } — aynı gün aynı kol+sembol bir kez
export function queue(om, today, sleeve, sym, type, src) {
  if (om.pending.some(p => p.sleeve === sleeve && p.sym === sym && p.d === today)) return;
  om.pending.push({ d: today, sleeve, sym, type, src });
}

const legs = (ex, type) => (type === "P" ? ex?.puts : ex?.calls) || [];
const fillBuy = c => c.mid + OMCFG.SLIP * (c.ask - c.bid);
const fillSell = c => Math.max(0, c.mid - OMCFG.SLIP * (c.ask - c.bid));
export const sleeveEquity = s => s.cash + s.pos.reduce((a, p) => a + (p.lastVal ?? p.cost), 0);

// Girişler: chainFor(sym, lo, hi) → loadChain sonucu. Dönüş: alınanlar
export async function enterPending(om, today, chainFor) {
  const bought = [];
  const todo = om.pending.splice(0);
  for (const p of todo) {
    const s = om.sleeves[p.sleeve], cfg = SLEEVES[p.sleeve];
    if (p.d !== today) continue;                                   // bayat sinyal (önceki gün) → alınmaz, düşer
    if (!s || s.pos.length >= OMCFG.MAXPOS || s.pos.some(x => x.sym === p.sym)) continue;
    if (cfg.daily && s.pos.filter(x => x.d === today && x.type === p.type).length >= (cfg.daily[p.type] ?? 99)) continue;
    const ch = await chainFor(p.sym, cfg.lo, cfg.hi).catch(() => null);
    const ex = (ch?.expiries || []).filter(e => e.dte >= cfg.lo && e.dte <= cfg.hi).sort((a, b) => a.dte - b.dte)[0];
    const c = legs(ex, p.type).filter(o => o.liquid && o.delta != null)
      .sort((a, b) => Math.abs(Math.abs(a.delta) - cfg.delta) - Math.abs(Math.abs(b.delta) - cfg.delta))[0];
    if (!c) continue;
    const px = fillBuy(c), eq = sleeveEquity(s), budget = Math.min(eq * OMCFG.PCT, s.cash);
    let n = Math.floor(budget / (px * 100));
    if (n < 1 && px * 100 <= Math.min(eq * OMCFG.MIN1_PCT, s.cash)) n = 1;   // pahalı kontrat: tek adet, kolun ≤ %20'si
    if (n < 1) continue;
    const cost = n * px * 100;
    s.cash -= cost;
    const pos = { sym: p.sym, type: p.type, src: p.src, d: today, occ: c.sym, K: c.K, expTs: ex.exp,
      exp: new Date(ex.exp * 1e3).toISOString().slice(0, 10), n, px: +px.toFixed(2), cost: Math.round(cost), lastVal: Math.round(cost) };
    s.pos.push(pos);
    bought.push({ sleeve: p.sleeve, ...pos });
  }
  return bought;
}

// Değerleme + çıkışlar (günde 1). quoteFor(pos) → { mid, bid, ask } | null. nowMs: dte hesabı için
export async function markAndExit(om, today, quoteFor, nowMs = Date.now()) {
  const sold = [];
  for (const [k, s] of Object.entries(om.sleeves)) {
    const cfg = SLEEVES[k];
    for (let i = s.pos.length - 1; i >= 0; i--) {
      const p = s.pos[i];
      const q = await quoteFor(p).catch(() => null);
      const left = dteLeft(p.expTs, nowMs);
      let val = null;
      if (q && q.mid > 0) val = fillSell(q) * 100 * p.n;
      else if (left < 0) val = 0;                                  // vadesi geçti, kotasyon yok → değersiz kabul
      if (val == null) continue;
      p.lastVal = Math.round(val);
      const ret = val / p.cost - 1;
      const why = ret <= OMCFG.SL ? "zarar durdur −%50" : left <= cfg.exitDte ? `vade yaklaştı (≤ ${cfg.exitDte} gün)` : null;
      if (!why) continue;
      s.cash += val;
      const rec = { ...p, exitD: today, val: Math.round(val), ret: +ret.toFixed(4), pnl: Math.round(val - p.cost), why };
      s.closed.push(rec); s.pos.splice(i, 1);
      if (s.closed.length > 300) s.closed.splice(0, s.closed.length - 300);
      sold.push({ sleeve: k, ...rec });
    }
    const snap = { d: today, eq: Math.round(sleeveEquity(s)) }, last = s.hist.at(-1);
    if (last?.d === today) s.hist[s.hist.length - 1] = snap; else s.hist.push(snap);
    if (s.hist.length > 800) s.hist.splice(0, s.hist.length - 800);
  }
  return sold;
}

const pc = v => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
export function fmtOptModel(om, fromD, toD = null) {
  if (!om) return "🎯 OPSİYON MODEL PORTFÖYLERİ: henüz başlamadı.";
  const L = [`🎯 OPSİYON MODEL PORTFÖYLERİ (yalnız alım · her kol $${OMCFG.CAP.toLocaleString("en-US")})`];
  for (const [k, s] of Object.entries(om.sleeves)) {
    const cfg = SLEEVES[k];
    const h = toD ? s.hist.filter(x => x.d <= toD) : s.hist;
    const end = h.at(-1)?.eq ?? sleeveEquity(s);
    const base = [...h].reverse().find(x => x.d <= fromD && x.d !== om.start)?.eq ?? OMCFG.CAP;
    const tr = s.closed.filter(t => t.exitD > fromD && (!toD || t.exitD <= toD));
    const w = tr.filter(t => t.ret > 0).length;
    L.push(`• ${cfg.lab} (vade ${cfg.lo}–${cfg.hi}g): dönem ${pc(end / base - 1)} · başlangıçtan ${pc(end / OMCFG.CAP - 1)} · özsermaye $${end.toLocaleString("en-US")}` +
      ` · kapanan ${tr.length}${tr.length ? ` (kazanan %${Math.round(w / tr.length * 100)})` : ""} · açık ${s.pos.length}`);
    for (const p of s.pos.slice(0, 4)) L.push(`   ${p.sym} ${p.K}${p.type} ${p.exp.slice(5)} ×${p.n} · ${pc((p.lastVal ?? p.cost) / p.cost - 1)} (${p.src})`);
  }
  return L.join("\n");
}

export function fmtOptTrades(bought, sold) {
  const L = ["🎯 OPSİYON MODEL PORTFÖYÜ — işlem"];
  for (const b of bought) L.push(`🟢 [${SLEEVES[b.sleeve].lab}] AL ${b.sym} ${b.K}${b.type} · vade ${b.exp} · ×${b.n} @ $${b.px} (~$${b.cost}) · kaynak: ${b.src}`);
  for (const s of sold) L.push(`${s.ret >= 0 ? "✅" : "❌"} [${SLEEVES[s.sleeve].lab}] SAT ${s.sym} ${s.K}${s.type} · ${s.why} · ${pc(s.ret)} ($${s.pnl})`);
  return L.join("\n");
}
