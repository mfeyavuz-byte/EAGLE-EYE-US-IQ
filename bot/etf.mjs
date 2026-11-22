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
  PUTS: process.env.ETF_PUTS !== "0",          // düşüş sinyalinde long put (yalnız ALIM; satış yok)
};
// AŞIRI KORKU kuralı (research/feargreed.mjs): Korku & Açgözlülük < 25 → 10 işlem günü call; endeks ≥ 50 olursa erken çık.
// Aşırı açgözlülük (> 75) iki dönemde tutarsız → put sinyali OLARAK KULLANILMAZ. FG_ETF=0 kapatır.
export const FG_RULE = { ON: process.env.FG_ETF !== "0", ENTRY: 25, EXIT: 50, HOLD: 10 };
const fill = (o, side) => o.mid + side * SLIP * (o.ask - o.bid);
const trDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// Zincirden kontrat: vade ≥ DTE olan ilk vade, likit call (type "C") ya da put ("P") içinde |delta| hedefe en yakın.
export function pickContract(chain, dte = ETF_OPT.DTE, delta = ETF_OPT.DELTA, type = "C") {
  const ex = (chain?.expiries || []).filter(e => e.dte >= dte).sort((a, b) => a.dte - b.dte)[0];
  if (!ex) return null;
  const list = type === "P" ? ex.puts || [] : ex.calls || [];
  const c = list.filter(o => o.liquid && o.delta != null).sort((a, b) => Math.abs(Math.abs(a.delta) - delta) - Math.abs(Math.abs(b.delta) - delta))[0];
  return c ? { ex, c } : null;
}
const legsOf = (ex, type) => (type === "P" ? ex?.puts : ex?.calls) || [];

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
      const type = pos.type || "C", td = tradingDays(pos.d, today);
      // Korku sinyali (kind "fg"): 10 işlem günü ya da endeks ≥ 50'ye (nötre) dönünce çık; diğerleri: 5g ortalama kuralı
      const isFg = pos.kind === "fg";
      const hit = isFg ? deps.fg != null && deps.fg >= FG_RULE.EXIT : type === "P" ? s.putExit : s.exit;
      const maxD = isFg ? FG_RULE.HOLD : ETF_CFG.MAXD;
      if (!(hit || td >= maxD)) continue;
      const chain = await deps.chainFor(sym, pos.expTs);              // pozisyonun kendi vadesi
      const ex = chain?.expiries.find(e => e.exp === pos.expTs);
      const o = legsOf(ex, type).find(x => x.sym === pos.occ) || legsOf(ex, type).find(x => x.K === pos.K);
      if (!o || !(o.mid > 0)) { st.etf.last[sym] = null; continue; } // kotasyon yok → sonraki run tekrar dene
      const px = Math.max(0, fill(o, -1)), ret = px / pos.px - 1;
      const rec = { ...pos, type, exitD: today, exitPx: +px.toFixed(2), ret: +ret.toFixed(4), pnl: Math.round((px - pos.px) * 100), td,
        why: hit ? (isFg ? `korku endeksi ${deps.fg}'e döndü (nötr)` : type === "P" ? "5g ortalamanın altında kapandı" : "5g ortalamanın üstünde kapandı") : `${maxD} işlem günü doldu`,
        undRet: +(s.price / pos.S - 1).toFixed(4) };
      st.etf.book.push(rec); delete st.etf.pos[sym];
      if (st.etf.book.length > 300) st.etf.book.splice(0, st.etf.book.length - 300);
      out.push(`📕 ETF KAPAT — ${sym} ${pos.K}${type} (${trDate(pos.exp)})\n${rec.why} · ${td} gün · dayanak ${(rec.undRet * 100).toFixed(1)}%\n` +
        `Giriş $${pos.px} → çıkış ~$${rec.exitPx} · ${ret >= 0 ? "✅" : "❌"} ${(ret * 100).toFixed(1)}% (${rec.pnl >= 0 ? "+" : "−"}$${Math.abs(rec.pnl)}/kontrat)`);
      continue;
    }
    // Öncelik: RSI(2) call (en güçlü, ~3 gün) → AŞIRI KORKU call (5–10 gün) → zayıf put
    const fgHit = FG_RULE.ON && deps.fg != null && deps.fg < FG_RULE.ENTRY;
    const type = s.tier ? "C" : fgHit ? "C" : s.putTier && ETF_OPT.PUTS ? "P" : null;
    if (!type) continue;
    const kind = s.tier ? "rsi" : fgHit ? "fg" : "put";
    const tierLab = kind === "rsi" ? (s.tier === "güçlü" ? "GÜÇLÜ" : "normal") : kind === "fg" ? "AŞIRI KORKU" : "zayıf";
    const chain = await deps.chainFor(sym);
    const pick = pickContract(chain, ETF_OPT.DTE, ETF_OPT.DELTA, type);
    if (!pick) { out.push(`ℹ ${sym}: ${type === "C" ? "call" : "put"} sinyali var (${tierLab}) ama uygun likit kontrat bulunamadı.`); continue; }
    const { ex, c } = pick, px = +fill(c, 1).toFixed(2);
    const expD = new Date(ex.exp * 1e3).toISOString().slice(0, 10);
    st.etf.pos[sym] = { sym, type, kind, d: today, occ: c.sym, K: c.K, exp: expD, expTs: ex.exp, px, S: s.price, tier: kind === "rsi" ? s.tier : kind === "fg" ? `korku ${deps.fg}` : s.putTier };
    const C = type === "C";
    if (kind === "fg") {
      const maxD = new Date(Date.parse(today + "T12:00:00Z") + 15 * 864e5).toISOString().slice(0, 10);
      out.push([
        `😱 ETF FIRSAT — ${sym} CALL (AŞIRI KORKU · 5–10 gün)`,
        `Korku & Açgözlülük endeksi ${deps.fg}/100 (< ${FG_RULE.ENTRY}) · fiyat $${s.price.toFixed(2)} · 200g ort. $${s.sma200.toFixed(2)} (${s.up200 ? "üstünde" : "altında"})`,
        `AL ${c.K}C · vade ${trDate(expD)} (${ex.dte}g) · delta ${c.delta.toFixed(2)} · ~$${px} (orta $${c.mid.toFixed(2)}, spread %${(c.spreadPct * 100).toFixed(1)})`,
        `ÇIKIŞ PLANI: endeks ${FG_RULE.EXIT}'ye (nötre) dönünce ya da en geç ${FG_RULE.HOLD} işlem günü (~${trDate(maxD)}) → bot KAPAT mesajı atar.`,
        `Boyut: ödenen prim hesabın en çok %${ETF_OPT.MAX_RISK * 100}'si (1 kontrat $${Math.round(px * 100)}). Korku dönemlerinde oynaklık yüksektir; opsiyon sıfırlanabilir.`,
        `Geçmiş (2008–2026, eğitim/test ayrı): aşırı korkuda 10 gün sonra SPY ort. +%0.62 / +%0.73 (taban +%0.28 / +%0.53), QQQ +%0.76 / +%1.01; yükselen oran ~%61–62 (tabanla benzer) → avantaj ortalamada, isabette değil.`,
      ].join("\n"));
      continue;
    }
    const maxD = new Date(Date.parse(today + "T12:00:00Z") + 14 * 864e5).toISOString().slice(0, 10);
    out.push([
      `${C ? "📈" : "📉"} ETF FIRSAT — ${sym} ${C ? "CALL" : "PUT"} (${tierLab} sinyal)`,
      C ? `Yükselen trendde kısa vadeli aşırı satım: RSI(2) ${s.rsi2.toFixed(1)} · fiyat $${s.price.toFixed(2)} > 200g ort. $${s.sma200.toFixed(2)}`
        : `Düşen trendde kısa vadeli aşırı alım: RSI(2) ${s.rsi2.toFixed(1)} · fiyat $${s.price.toFixed(2)} < 200g ort. $${s.sma200.toFixed(2)}`,
      `AL ${c.K}${type} · vade ${trDate(expD)} (${ex.dte}g) · delta ${c.delta.toFixed(2)} · ~$${px} (orta $${c.mid.toFixed(2)}, spread %${(c.spreadPct * 100).toFixed(1)})`,
      `ÇIKIŞ PLANI: ${sym} kapanışı 5 günlük ortalamanın (şu an $${s.sma5.toFixed(2)}) ${C ? "üstüne çıkınca" : "altına inince"} ya da en geç ${ETF_CFG.MAXD} işlem günü (~${trDate(maxD)}) → bot KAPAT mesajı atar.`,
      `Boyut: ödenen prim hesabın en çok %${ETF_OPT.MAX_RISK * 100}'si (1 kontrat $${Math.round(px * 100)} → en az $${Math.ceil(px * 100 / ETF_OPT.MAX_RISK / 1000) * 1000} hesap). Opsiyon sıfırlanabilir.`,
      C ? `Geçmiş (dayanak, 1993–2026): bu kuralda isabet SPY %78–82, QQQ %71–81 · ort. +%0.6–0.8 · ~3 gün. Kayıp işlemler de olur (en kötü %5 ort. −%4…−7).`
        : `Geçmiş (dayanak, 1993–2026): isabet SPY %59–72, QQQ %55–63 · ort. düşüş +%0.15–0.94 · ~4 gün. Call kuralından ZAYIF; daha küçük pozisyon düşün.`,
    ].join("\n"));
  }
  return out;
}

export function fmtEtfBook(st) {
  const b = st.etf?.book || [], open = Object.values(st.etf?.pos || {});
  const L = ["📒 ETF KARNESİ (SPY/QQQ kısa vade call/put alımı)"];
  if (b.length) {
    const n = b.length, w = b.filter(x => x.ret > 0).length, pnl = b.reduce((a, x) => a + x.pnl, 0);
    L.push(`Kapanan ${n} · isabet %${Math.round(w / n * 100)} · ort. ${(b.reduce((a, x) => a + x.ret, 0) / n * 100).toFixed(1)}% · toplam ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl)}/kontrat · ort. ${(b.reduce((a, x) => a + x.td, 0) / n).toFixed(1)} gün`);
    for (const x of b.slice(-5)) L.push(`• ${x.sym} ${x.K}${x.type || "C"} ${x.d} → ${x.exitD} · ${(x.ret * 100).toFixed(1)}%`);
  } else L.push("Henüz kapanan işlem yok.");
  for (const p of open) L.push(`Açık: ${p.sym} ${p.K}${p.type || "C"} (${trDate(p.exp)}) · ${p.d} · giriş $${p.px}`);
  return L.join("\n");
}

// /etf: SPY/QQQ'nun anlık durumu
export function fmtEtfState(sym, s) {
  if (!s) return `${sym}: veri yok`;
  return `${sym} $${s.price.toFixed(2)} · RSI(2) ${s.rsi2.toFixed(1)} · 200g ${s.up200 ? "üstünde" : "altında"} ($${s.sma200.toFixed(2)}) · 5g $${s.sma5.toFixed(2)}` +
    (s.tier ? ` · 🔔 CALL SİNYALİ (${s.tier})` : s.putTier ? " · 🔔 PUT SİNYALİ (zayıf)"
      : s.up200 ? ` · call için RSI(2) < ${ETF_CFG.RSI_NORMAL} gerekir` : ` · trend aşağı → put için RSI(2) > ${ETF_CFG.RSI_PUT} gerekir`);
}
