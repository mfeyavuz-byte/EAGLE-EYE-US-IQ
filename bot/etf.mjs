// SPY / QQQ KISA VADE CALL FIRSATLARI — canlı uygulama (spot/etfsignal.mjs kuralı, yalnız ALIM).
// Her gün 15:30 NY sonrası (kapanışa yakın, araştırmadaki "kapanışta gir" ile uyumlu) bir kez:
//  • açık pozisyon varsa: dayanak 5g ortalamanın üstündeyse ya da 10 işlem günü dolduysa → KAPAT mesajı + karne
//  • yoksa ve sinyal varsa: canlı zincirden kontrat seçilir (vade ≥ ETF_DTE gün, delta ≈ ETF_DELTA, likit) → FIRSAT mesajı
// Fiyatlar: giriş orta + %30 spread, çıkış orta − %30 spread (bizim aleyhimize).
import { etfState, ETF_CFG, ETFS_FAST } from "../spot/etfsignal.mjs";
import { tradingDays } from "./spotbook.mjs";
import { SLIP } from "../options/strategies.mjs";

export const ETF_OPT = {
  DTE: +(process.env.ETF_DTE || 30),          // en kısa vade (takvim günü) — geriye dönük testle seçilir
  DELTA: +(process.env.ETF_DELTA || 0.6),
  MAX_RISK: +(process.env.ETF_RISK || 0.02),   // ödenen prim en çok hesabın %2'si (opsiyon tamamen sıfırlanabilir)
};
const fill = (o, side) => o.mid + side * SLIP * (o.ask - o.bid);
const trDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// Zincirden kontrat: vade ≥ DTE olan ilk vade, likit call'lar içinde delta hedefe en yakın.
export function pickContract(chain, dte = ETF_OPT.DTE, delta = ETF_OPT.DELTA) {
  const ex = (chain?.expiries || []).filter(e => e.dte >= dte).sort((a, b) => a.dte - b.dte)[0];
  if (!ex) return null;
  const c = ex.calls.filter(o => o.liquid && o.delta != null).sort((a, b) => Math.abs(a.delta - delta) - Math.abs(b.delta - delta))[0];
  return c ? { ex, c } : null;
}

// deps: { closesFor(sym) → kapanışlar (son = güncel fiyat), chainFor(sym) → loadChain sonucu, today, msg(text) }
export async function runEtf(st, deps) {
  const { today } = deps;
  st.etf ||= { pos: {}, book: [], last: {} };
  const out = [];
  for (const sym of ETFS_FAST) {
    if (st.etf.last[sym] === today) continue;
    const closes = await deps.closesFor(sym);
    const s = closes && etfState(closes);
    if (!s) continue;
    st.etf.last[sym] = today;
    const pos = st.etf.pos[sym];
    if (pos) {
      const td = tradingDays(pos.d, today);
      if (!(s.exit || td >= ETF_CFG.MAXD)) continue;
      const chain = await deps.chainFor(sym, pos.expTs);              // pozisyonun kendi vadesi
      const ex = chain?.expiries.find(e => e.exp === pos.expTs);
      const o = ex?.calls.find(x => x.sym === pos.occ) || ex?.calls.find(x => x.K === pos.K);
      if (!o || !(o.mid > 0)) { st.etf.last[sym] = null; continue; } // kotasyon yok → sonraki run tekrar dene
      const px = Math.max(0, fill(o, -1)), ret = px / pos.px - 1;
      const rec = { ...pos, exitD: today, exitPx: +px.toFixed(2), ret: +ret.toFixed(4), pnl: Math.round((px - pos.px) * 100), td,
        why: s.exit ? "5g ortalamanın üstünde kapandı" : `${ETF_CFG.MAXD} işlem günü doldu`, undRet: +(s.price / pos.S - 1).toFixed(4) };
      st.etf.book.push(rec); delete st.etf.pos[sym];
      if (st.etf.book.length > 300) st.etf.book.splice(0, st.etf.book.length - 300);
      out.push(`📕 ETF KAPAT — ${sym} ${pos.K}C (${trDate(pos.exp)})\n${rec.why} · ${td} gün · dayanak ${(rec.undRet * 100).toFixed(1)}%\n` +
        `Giriş $${pos.px} → çıkış ~$${rec.exitPx} · ${ret >= 0 ? "✅" : "❌"} ${(ret * 100).toFixed(1)}% (${rec.pnl >= 0 ? "+" : "−"}$${Math.abs(rec.pnl)}/kontrat)`);
      continue;
    }
    if (!s.tier) continue;
    const chain = await deps.chainFor(sym);
    const pick = pickContract(chain);
    if (!pick) { out.push(`ℹ ${sym}: sinyal var (${s.tier}) ama uygun likit call bulunamadı.`); continue; }
    const { ex, c } = pick, px = +fill(c, 1).toFixed(2);
    const expD = new Date(ex.exp * 1e3).toISOString().slice(0, 10);
    st.etf.pos[sym] = { sym, d: today, occ: c.sym, K: c.K, exp: expD, expTs: ex.exp, px, S: s.price, tier: s.tier };
    const maxD = new Date(Date.parse(today + "T12:00:00Z") + 14 * 864e5).toISOString().slice(0, 10);
    out.push([
      `📈 ETF FIRSAT — ${sym} CALL (${s.tier === "güçlü" ? "GÜÇLÜ" : "normal"} sinyal)`,
      `Yükselen trendde kısa vadeli aşırı satım: RSI(2) ${s.rsi2.toFixed(1)} · fiyat $${s.price.toFixed(2)} > 200g ort. $${s.sma200.toFixed(2)}`,
      `AL ${c.K}C · vade ${trDate(expD)} (${ex.dte}g) · delta ${c.delta.toFixed(2)} · ~$${px} (orta $${c.mid.toFixed(2)}, spread %${(c.spreadPct * 100).toFixed(1)})`,
      `ÇIKIŞ PLANI: ${sym} kapanışı 5 günlük ortalamanın (şu an $${s.sma5.toFixed(2)}) üstüne çıkınca ya da en geç ${ETF_CFG.MAXD} işlem günü (~${trDate(maxD)}) → bot KAPAT mesajı atar.`,
      `Boyut: ödenen prim hesabın en çok %${ETF_OPT.MAX_RISK * 100}'si (1 kontrat $${Math.round(px * 100)} → en az $${Math.ceil(px * 100 / ETF_OPT.MAX_RISK / 1000) * 1000} hesap). Opsiyon sıfırlanabilir.`,
      `Geçmiş (dayanak, 1993–2026): bu kuralda isabet SPY %78–82, QQQ %71–81 · ort. +%0.6–0.8 · ~3 gün. Kayıp işlemler de olur (en kötü %5 ort. −%4…−7).`,
    ].join("\n"));
  }
  return out;
}

export function fmtEtfBook(st) {
  const b = st.etf?.book || [], open = Object.values(st.etf?.pos || {});
  const L = ["📒 ETF KARNESİ (SPY/QQQ kısa vade call)"];
  if (b.length) {
    const n = b.length, w = b.filter(x => x.ret > 0).length, pnl = b.reduce((a, x) => a + x.pnl, 0);
    L.push(`Kapanan ${n} · isabet %${Math.round(w / n * 100)} · ort. ${(b.reduce((a, x) => a + x.ret, 0) / n * 100).toFixed(1)}% · toplam ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl)}/kontrat · ort. ${(b.reduce((a, x) => a + x.td, 0) / n).toFixed(1)} gün`);
    for (const x of b.slice(-5)) L.push(`• ${x.sym} ${x.K}C ${x.d} → ${x.exitD} · ${(x.ret * 100).toFixed(1)}%`);
  } else L.push("Henüz kapanan işlem yok.");
  for (const p of open) L.push(`Açık: ${p.sym} ${p.K}C (${trDate(p.exp)}) · ${p.d} · giriş $${p.px}`);
  return L.join("\n");
}

// /etf: SPY/QQQ'nun anlık durumu
export function fmtEtfState(sym, s) {
  if (!s) return `${sym}: veri yok`;
  return `${sym} $${s.price.toFixed(2)} · RSI(2) ${s.rsi2.toFixed(1)} · 200g ${s.up200 ? "üstünde" : "altında"} ($${s.sma200.toFixed(2)}) · 5g $${s.sma5.toFixed(2)}` +
    (s.tier ? ` · 🔔 SİNYAL (${s.tier})` : s.up200 ? ` · sinyal için RSI(2) < ${ETF_CFG.RSI_NORMAL} gerekir` : " · trend aşağı → sinyal yok");
}
