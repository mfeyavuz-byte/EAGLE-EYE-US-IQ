#!/usr/bin/env node
// EAGLE-EYE US IQ — spot tarama + opsiyon öneri motoru → Telegram.
// GitHub Actions'ta seans boyunca ~10 dk'da bir çalışır; durum Gist'te (Node 22 ESM).
//
// Çıkış kodları: 0 = tamam · 3 = piyasa kapalı (workflow döngüsü durur) · 1 = hata
// Ortam: TG_TOKEN TG_CHAT GH_GIST_TOKEN GIST_ID [ALPACA_KEY_ID ALPACA_SECRET_KEY]
//        DRY_RUN=1 (Telegram'a gönderme) · FORCE=1 (piyasa kapalıyken de tara) · SYMBOLS=AAPL,MSFT (alt küme)
//        OPT_FORCE=1 (opsiyon fikirlerini saat beklemeden üret) · IV_FORCE=1 (IV geçmişi kaydını zorla)
//        MARK_FORCE=1 (karnedeki açık fikirleri saat beklemeden değerle)
import { scanAll, analyze, spyReturn60, loadUniverse, dailyCache, CFG, setMomCuts } from "../spot/scan.mjs";
import { logSignals, score, fmtSpotReport, checkExits, fmtExits, tradingDays, HOLD_DAYS } from "./spotbook.mjs";
import { addWatch, removeWatch, checkWatch, fmtWatch } from "./watch.mjs";
import { paperEnabled, runPaper, paperSummary } from "./paper.mjs";
import { liveQuotes, alpacaEnabled, news, isTradingDay } from "../data/alpaca.mjs";
import { isMarketOpen, isRegularHours, nyDate, nyParts, fmtTR } from "../data/market.mjs";
import { riskFreeRate, fetchDaily, fetchHistory, optionChain, quoteNow, valuationQuotes, qualityStats } from "../data/yahoo.mjs";
import { loadFG, fgLabel } from "../spot/feargreed.mjs";
import { buildMorning, settleMorning, fmtMorningBook, MORNING } from "./morning.mjs";
import { loadFiles, saveFiles, READ_FAILED, gistEnabled, STATE_FILE, IVHIST_FILE, trimState } from "./state.mjs";
import { sendTG, sendPhoto, fetchCommands } from "./telegram.mjs";
import { chartUrl, chartsEnabled } from "./chart.mjs";
import { aiComments, aiItem, AI_MODEL } from "./ai.mjs";
import { analyzeOptions, OCFG, setEdges } from "../options/engine.mjs";
import { calibrate, fmtCalib } from "./calib.mjs";
import { initModel, stepModel, equity, fmtModel, dueReports, prevMonthEnd, prevQuarterEnd, shiftDays, MCFG, periodStats } from "./model.mjs";
import { rankValue, pickValue, initValue, rebalanceValue, snapValue, fmtValueTrades, fmtValue, VCFG } from "./value.mjs";
import { initOptModel, queue, enterPending, markAndExit, fmtOptModel, fmtOptTrades } from "./optmodel.mjs";
import { runEtf, fmtEtfBook, fmtEtfState, ETF_OPT } from "./etf.mjs";
import { etfState, ETFS_FAST } from "../spot/etfsignal.mjs";
import { loadChain } from "../options/chain.mjs";
import { fmtAnalysis, fmtDailyIdeas } from "../options/format.mjs";
import { histOf, snapshot } from "../options/ivhist.mjs";
import { addIdeas, settle, stats, fmtStats, markBook, fmtClosed } from "../options/book.mjs";
import { pathToFileURL } from "node:url";
import { macroEvents, fmtMacroDay } from "./macro.mjs";
import { IDEA_FILES, fmtIdeaReport } from "./ideabook.mjs";
import { rankEdge, fmtSectors } from "./edge.mjs";
import { newsSentiment, newsTag } from "./news.mjs";

const UNI = loadUniverse();
const SYMS = process.env.SYMBOLS ? process.env.SYMBOLS.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : UNI.symbols;
const FORCE = process.env.FORCE === "1";
const ETFS = ["SPY", "QQQ", "IWM"];                       // nötr (iron condor) fikirleri için endeks ETF'leri
const usd = v => (v == null ? "—" : "$" + (+v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const sgn = v => (v >= 0 ? "+" : "") + v;
const DISCLAIMER = "⚠ Yatırım tavsiyesi değildir.";

// Günlük üst sınır: filtreyi geçenlerden yalnızca en kaliteli ilk N yeni sinyal gönderilir (gürültü freni).
export const DAY_CAP = { AL: +(process.env.MAX_AL_DAY || 10), SAT: +(process.env.MAX_SAT_DAY || 6) };
// Sektör sınırı: aynı gün aynı sektörden en çok SEC_CAP sinyal (aynı yönde) — 3 biyoteknoloji = tek bahis.
export const SEC_CAP = +(process.env.SEC_CAP || 3);
// Pozisyon boyutu (AL): portföyün RISK_SPOT'u stop'a kadar riske → boyut = risk ÷ stop mesafesi, en çok %MAX_POS.
export const RISK_SPOT = +(process.env.RISK_SPOT || 0.01), MAX_POS = +(process.env.MAX_POS || 0.10);
export const sizeFor = s => (s.signal === "AL" && s.stopLoss && s.price > s.stopLoss)
  ? +Math.min(MAX_POS, RISK_SPOT / ((s.price - s.stopLoss) / s.price)).toFixed(3) : null;
// signals kalite sırasıyla gelir (scanAll). Aynı gün aynı sinyal tekrar gönderilmez; kota dolunca kalanlar bekler.
export function pickFresh(signals, sent, cap = DAY_CAP, secOf = s => UNI.meta?.[s]?.sec || null) {
  sent.n ||= { AL: 0, SAT: 0 };
  sent.sec ||= {};
  const out = [];
  for (const s of signals) {
    if (sent.map[s.sym] === s.signal) continue;
    if ((sent.n[s.signal] || 0) >= (cap[s.signal] ?? 0)) continue;
    const sec = secOf(s.sym), sk = sec && `${s.signal}|${sec}`;
    if (sk && (sent.sec[sk] || 0) >= SEC_CAP) continue;
    sent.map[s.sym] = s.signal; sent.n[s.signal] = (sent.n[s.signal] || 0) + 1;
    if (sk) sent.sec[sk] = (sent.sec[sk] || 0) + 1;
    s.sizePct = sizeFor(s);
    out.push(s);
  }
  return out;
}

// ---------- Mesaj biçimleri ----------
export function fmtSignal(a) {
  const icon = a.signal === "AL" ? "🟢" : "🔴";
  const parts = [`${icon} ${a.sym} ${usd(a.price)}`];
  if (a.signal === "AL" && a.mom12 != null) {
    parts.push(`mom12 ${sgn(+(a.mom12 * 100).toFixed(0))}%`);
    if (a.hi52 != null) parts.push(`zirveye −${((1 - a.hi52) * 100).toFixed(0)}%`);
  } else parts.push(`güven %${a.confidence}`, `ADX ${a.adx}`);
  if (a.rsi != null) parts.push(`RSI ${a.rsi}`);
  parts.push(`RS60 ${sgn(a.rs60)}`);
  if (a.stopLoss) parts.push(`stop ${usd(a.stopLoss)}`);
  if (a.target1) parts.push(`hedef ${usd(a.target1)}`);
  if (a.rr) parts.push(`R:R ${a.rr}`);
  if (a.sizePct) parts.push(`boyut ~%${Math.round(a.sizePct * 100)} portföy`);
  if (a.dip) parts.push("DİP");
  if (a.edgeTag) parts.push(a.edgeTag);
  return parts.join(" · ");
}

const SIG_KEYS = ["sym", "signal", "price", "confidence", "adx", "rsi", "rs60", "stopLoss", "target1", "rr", "dip", "mom12", "hi52", "sizePct", "edgeTag"];
export const compactSignal = a => Object.fromEntries(SIG_KEYS.map(k => [k, a[k]]));

// /sinyaller: filtreyi geçen TÜM sinyaller, AL ve SAT ayrı başlıklarla (kalite sırasıyla). Kesme yok.
export function fmtSignalList(ls) {
  const al = ls.signals.filter(s => s.signal === "AL"), sat = ls.signals.filter(s => s.signal === "SAT");
  const L = [`📋 Son tarama (${ls.at}) · ${ls.analyzed ?? "?"} hisse · filtreyi geçen ${ls.signals.length}`];
  if (al.length) L.push("", `AL (${al.length})`, ...al.map(fmtSignal));
  if (sat.length) L.push("", `SAT (${sat.length})`, ...sat.map(fmtSignal));
  if (!ls.signals.length) L.push("", "Filtreyi geçen sinyal yok.");
  return L.join("\n");
}

export function fmtDetail(a, newsList = []) {
  if (!a) return "Veri alınamadı (sembol hatalı olabilir).";
  const L = [
    `🔎 ${a.sym} — ${usd(a.price)}${a.live ? " (canlı · IEX)" : " (Yahoo)"}`,
    `Seçim: ${a.pick ? (a.pick === "AL" ? "🟢 AL (momentum lideri geri çekilmede)" : "🔴 SAT (teyitli düşüş + zayıf momentum)") : "— (kurallara uymuyor)"}`,
    `Momentum 12a ${a.mom12 != null ? sgn(+(a.mom12 * 100).toFixed(1)) + "%" : "—"}${a.momRank != null ? ` (evren sırası ~%${Math.round(a.momRank * 100)})` : ""} · 52h zirveye ${a.hi52 != null ? "−" + ((1 - a.hi52) * 100).toFixed(1) + "%" : "—"} · 200g ort. ${a.a200 != null ? sgn(+(a.a200 * 100).toFixed(1)) + "%" : "—"}`,
    `Teknik motor: ${a.engSignal ?? a.signal} · güven %${a.confidence}${a.mod ? " · " + a.mod : ""}`,
    `Trend (haftalık): ${a.htf || "?"}${a.htfNote ? " · " + a.htfNote : ""}`,
    `ADX ${a.adx} · RSI ${a.rsi ?? "—"} · ATR ${a.atr ?? "—"}`,
    `60g getiri ${sgn(a.ret60)}% · SPY'a göre ${sgn(a.rs60)}%`,
    `Hacim temposu ${a.volPace}× · ort. işlem hacmi ${usd(Math.round(a.dollarVol / 1e6))}M`,
  ];
  if (a.stopLoss || a.target1) L.push(`Stop ${usd(a.stopLoss)} · Hedef1 ${usd(a.target1)} · Hedef2 ${usd(a.target2)} · R:R ${a.rr || "—"}`);
  if (a.entryHint) L.push(`Giriş: ${a.entryHint}`);
  if (Array.isArray(a.waitReasons) && a.waitReasons.length) L.push(`Bekleme nedenleri: ${a.waitReasons.slice(0, 3).join(" · ")}`);
  if (newsList.length) {
    L.push("", "📰 Son haberler:");
    for (const n of newsList) L.push(`• ${n.t ? n.t.slice(5, 10).split("-").reverse().join(".") + " " : ""}${n.headline}${n.source ? ` (${n.source})` : ""}`);
  }
  L.push("", "Opsiyon yapıları için: /opsiyon " + a.sym, DISCLAIMER);
  return L.join("\n");
}

const HELP = [
  "🦅 EAGLE-EYE US IQ komutları",
  "/hisse SEMBOL — teknik analiz (örn. /hisse NVDA)",
  "/opsiyon SEMBOL — oynaklık panosu + en iyi 3 opsiyon yapısı (örn. /opsiyon AAPL)",
  "/sinyaller — son taramanın AL/SAT listesi",
  "/karne — gönderilen opsiyon fikirlerinin gerçekleşen sonuçları (model isabeti)",
  "/spotkarne — gönderilen spot sinyallerinin son 30 gündeki sonucu (SPY'a göre)",
  "/takip SEMBOL — sahip olduğun hisseyi izle (SAT seçimi, 200g kırılımı, zirveden −%8 uyarısı)",
  "/birak SEMBOL — takipten çıkar · /takiplerim — takip listesi",
  "/portfoy — model portföy (sanal, 15 slot; haftalık Cuma, aylık ve 3 aylık rapor otomatik gelir)",
  "/etf — SPY/QQQ kısa vade call/put sinyalinin durumu + ETF karnesi",
  "/sabah — açılış öncesi SPY/QQQ çağrılarının karnesi (mesaj her işlem günü ~08:00–09:30 NY)",
  "/fikirkarne — 15 dk SPY/QQQ fikirleri ve ani hareket alarmlarının gerçekleşen sonuçları",
  "/durum — bot durumu",
  "/yardim — bu liste",
].join("\n");

// ---------- Değer (ucuz hisse) portföyü ----------
async function valueStep(st, today, mins, all, spyPx) {
  const px = new Map(all.map(a => [a.sym, a.price])), priceOf = s => px.get(s);
  st.vmodel ||= initValue(today, spyPx);
  const v = st.vmodel, due = !v.lastRebal || (v.lastRebal.slice(0, 7) !== today.slice(0, 7) && mins >= 600) || process.env.VALUE_FORCE === "1";
  if (due) {
    const byS = new Map(all.map(a => [a.sym, a]));
    const cands = UNI.symbols.filter(s => { const m = UNI.meta?.[s]; return byS.has(s) && (m?.idx === "SP500" || (m?.mcapB ?? 0) * 1e9 >= VCFG.MIN_MCAP_NQ); });
    const vq = await valuationQuotes(cands);
    // Ön eleme (yalnız değerleme): kârlı ve fiyatı ≥ $10 olanlar içinde kazanç/defter verimine göre ilk 60 → kalite verisi
    const pre = cands.map(s => ({ sym: s, ...vq[s] })).filter(r => r.price >= 10 && r.eps > 0)
      .map(r => ({ ...r, pre: (r.pe > 0 ? 1 / r.pe : 0) + (r.fpe > 0 ? 1 / r.fpe : 0) + (r.pb >= 0.1 ? 0.2 / r.pb : 0) }))
      .sort((a, b) => b.pre - a.pre).slice(0, 60);
    const rows = [];
    for (const r of pre) {
      const a = byS.get(r.sym);
      rows.push({ ...r, sec: UNI.meta?.[r.sym]?.sec, q: await qualityStats(r.sym).catch(() => null), hi52: a?.hi52 ?? null, pick: a?.pick ?? null, price: a?.price ?? r.price });
    }
    const picks = pickValue(rankValue(rows));
    if (picks.length >= 5) {                                       // veri eksikse dengeleme ertelenir (yanlış liste kurulmaz)
      const { bought, sold } = rebalanceValue(v, today, picks, priceOf);
      await sendTG(fmtValueTrades(bought, sold) + `\nAday ${cands.length} · kalite incelenen ${rows.length} · seçilen ${picks.length}`);
    } else console.error(`[Değer] yetersiz veri (${picks.length} seçim) — dengeleme ertelendi`);
  }
  snapValue(v, today, priceOf, spyPx);
}

// ---------- Korku & Açgözlülük (CNN yöntemiyle kendi hesabımız) ----------
// Günde en çok 2 kez: ilk ihtiyaçta (sabah: dünkü kapanışlarla) ve 15:30 NY sonrası (kapanışa yakın değerlerle).
export async function getFG(st, late = false) {
  const today = nyDate();
  if (st.fg?.at === today && (!late || st.fg.late)) return st.fg;
  try {
    const s = await loadFG(fetchHistory, nyDate);
    const last = s.at(-1);
    if (!last) return st.fg || null;
    st.fg = { at: today, late, d: last.d, fg: last.fg, parts: last.parts, prev: s.at(-2)?.fg ?? null, wk: s.at(-6)?.fg ?? null };
  } catch (e) { console.error("[Korku/Açgözlülük]", e?.message || e); }
  return st.fg || null;
}
export function fmtFG(f) {
  if (!f) return "Korku & Açgözlülük: veri yok";
  const p = f.parts;
  return `😨 Korku & Açgözlülük ${f.fg}/100 — ${fgLabel(f.fg)}` + (f.prev != null ? ` (dün ${f.prev}, 1 hafta önce ${f.wk ?? "—"})` : "") +
    `\n   momentum ${p.mom} · oynaklık (VIX) ${p.vol} · güvenli liman ${p.haven} · riskli tahvil ${p.junk}` +
    (f.fg < 25 ? "\n   ↳ Aşırı korku: geçmişte 5–10 gün içinde SPY/QQQ ortalamada tabanın üstünde (alım yönü)." : "");
}

// ---------- Açılış öncesi mesaj ----------
async function completedCloses(sym, today) {
  const rows = await fetchDaily(sym).catch(() => []);
  return rows.filter(r => nyDate(new Date(r.ts)) < today).map(r => r.close);
}
async function morningStep(st, ctx) {
  const { mins, wd } = nyParts(), today = nyDate(), force = process.env.MORNING_FORCE === "1";
  st.morning ||= { book: [], day: null };
  // Geçmiş çağrıları o günün mumuyla sonuçlandır (günde 1)
  if (st.morning.settleDay !== today && st.morning.book.some(b => !b.res && b.d < today)) {
    st.morning.settleDay = today;
    await settleMorning(st.morning.book, today, async sym => (await fetchDaily(sym).catch(() => []))
      .map(r => ({ d: nyDate(new Date(r.ts)), open: r.open, high: r.high, low: r.low, close: r.close })));
  }
  if (!force && (wd === "Sat" || wd === "Sun" || mins < MORNING.START || mins >= MORNING.END || st.morning.day === today)) return;
  if (!force && (await isTradingDay(today)) === false) { st.morning.day = today; console.log("Sabah: bugün işlem günü değil."); return; }
  const r = await ctx.r();
  const fgNow = await getFG(st);
  const chains = {};                                               // ETF başına tek zincir (0DTE…~3 hafta)
  const { text, calls } = await buildMorning({
    today,
    closesFor: s => completedCloses(s, today),
    vixCloses: () => completedCloses("^VIX", today),
    futQuote: s => quoteNow(s),
    chainFor: async sym => (chains[sym] ??= await loadChain(sym, r, { minDte: 0, maxDte: 25, targets: [0, 1, 7, 18] })),
    headlines: async () => (await news("SPY", 4)).map(n => n.headline),
    fearGreed: async () => fmtFG(fgNow),
    fg: fgNow?.fg ?? null,
  });
  const macro = fmtMacroDay(await macroEvents().catch(() => []), today);   // CPI / istihdam / FOMC günü uyarısı
  if (await sendTG(macro ? `${text}\n\n${macro}` : text, { buttons: [[{ text: "⚡ SPY/QQQ durumu", data: "/etf" }, { text: "🌅 Sabah karnesi", data: "/sabah" }]] })) {
    st.morning.day = today;
    st.morning.book.push(...calls);
    st.om ||= initOptModel(today);
    for (const c of calls) queue(st.om, today, "W", c.sym, "C", `sabah skor ${c.score}`);   // haftalık kol
    if (st.morning.book.length > 400) st.morning.book.splice(0, st.morning.book.length - 400);
  }
}

// ---------- Canlı veri çapraz kontrolü (seans içinde): Alpaca IEX vs Yahoo, SPY ----------
export function crossProblem(alp, yq, now = Date.now()) {
  if (!alp?.price) return { problem: "SPY için Alpaca canlı fiyatı gelmedi", ageMin: null, diffPct: null };
  const ageMin = Math.round((now - alp.ts) / 60e3);
  const diffPct = yq?.price ? +((alp.price / yq.price - 1) * 100).toFixed(2) : null;
  const problem = ageMin > 5 ? `SPY canlı fiyatı ${ageMin} dk bayat` : diffPct != null && Math.abs(diffPct) > 0.3 ? `Alpaca ve Yahoo SPY fiyatı %${diffPct} farklı` : null;
  return { problem, ageMin, diffPct, alpaca: alp.price, yahoo: yq?.price ?? null };
}

// ---------- Veri sağlığı ----------
// liveMap: { SYM: {price, ts} } · of: taranan hisse sayısı. Sorun: Alpaca açıkken canlı fiyat < %50 ya da
// medyan yaş > 30 dk (seans içinde). Alpaca kapalıysa kaynak Yahoo (gecikmeli) olarak bildirilir.
export function dataHealth(liveMap, of, open = true, now = Date.now()) {
  const ages = Object.values(liveMap || {}).map(q => (now - q.ts) / 60e3).filter(isFinite).sort((a, b) => a - b);
  const live = ages.length, med = live ? Math.round(ages[Math.floor(live / 2)]) : null;
  const src = alpacaEnabled() ? "Alpaca (canlı IEX + SIP günlük)" : "Yahoo (gecikmeli, Alpaca anahtarı yok)";
  let problem = null;
  if (open && alpacaEnabled()) {
    if (live < of * 0.5) problem = `canlı fiyat yalnız ${live}/${of} hissede geldi`;
    else if (med > 30) problem = `canlı fiyatlar bayat (medyan ${med} dk)`;
  }
  return { at: fmtTR(), src, live, of, medAgeMin: med, problem };
}

// ---------- Spot karnesi ve haftalık rapor ----------
const daysAgo = (d, n) => new Date(Date.parse(d + "T12:00:00Z") - n * 864e5).toISOString().slice(0, 10);
function spotScored(st) {
  const p = st.lastPx?.p || {};
  return score(st.spotBook || [], s => p[s], st.lastPx?.spy);
}
export function weeklyReport(st, today, paperTxt = null, ideaTxt = null) {
  const sc = spotScored(st);
  const open = (st.optBook || []).filter(b => !b.closed);
  const L = [`📅 HAFTALIK RAPOR — ${today}`, "",
    fmtSpotReport(sc, daysAgo(today, 7), "📈 Bu haftanın spot sinyalleri"), "",
    fmtSpotReport(sc, daysAgo(today, 30), "📈 Son 30 gün"), "",
    fmtStats(stats(st.optBook || []))];
  if (paperTxt) L.push("", paperTxt);
  if (ideaTxt) L.push("", ideaTxt);
  if (st.fg) L.push("", fmtFG(st.fg));
  if (st.sectors?.top?.length) L.push("", fmtSectors(st.sectors));
  if (st.calib) L.push("", fmtCalib(st.calib));
  if (st.etf) L.push("", fmtEtfBook(st));
  if (st.morning?.book?.length) L.push("", fmtMorningBook(st.morning.book));
  if (Object.keys(st.watch || {}).length) L.push("", fmtWatch(st));
  if (open.length) {
    L.push("", "Açık opsiyon fikirleri:");
    for (const b of open) L.push(`• ${b.sym} ${b.code} ${b.legs.map(l => l.K + l.type).join("/")} (${b.exp}) · ${b.mark ? `güncel K/Z ${b.mark.pnl >= 0 ? "+" : ""}$${b.mark.pnl}` : "henüz değerlenmedi"}`);
  }
  L.push("", "ℹ Spot getirileri sinyal yönünde (SAT için düşüş = +). SPY'a göre = sinyalin piyasaya katkısı. " + DISCLAIMER);
  return L.join("\n");
}

// ---------- SPY/QQQ kapanışları (son eleman = güncel fiyat) ----------
async function etfCloses(sym) {
  const daily = dailyCache.get(sym) || (await fetchDaily(sym).catch(() => []));
  if (!daily.length) return null;
  dailyCache.set(sym, daily);
  const closes = daily.map(d => d.close);
  const live = (await liveQuotes([sym]).catch(() => ({})))[sym];
  if (live?.price > 0) {
    const lastD = nyDate(new Date(daily.at(-1).ts)), liveD = nyDate(new Date(live.ts));
    if (liveD === lastD) closes[closes.length - 1] = live.price;
    else if (liveD > lastD) closes.push(live.price);
  }
  return closes;
}

// ---------- Opsiyon: tek sembol ----------
async function optionsFor(sym, ivStore, r, spyRet60) {
  const spot = await analyze(sym, { spyRet60 }).catch(() => null);
  const daily = dailyCache.get(sym) || (await fetchDaily(sym));
  return analyzeOptions(sym, { spot, daily, r, hist: histOf(ivStore, sym) });
}

// ---------- Komutlar ----------
async function handleCommands(st, ivStore, ctx) {
  const { updates, offset } = await fetchCommands(st.tgOffset || 0);
  st.tgOffset = offset;
  for (const { text } of updates) {
    const [cmdRaw, arg] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().split("@")[0];
    const sym = (arg || "").toUpperCase().replace(/[^A-Z.\-]/g, "");
    if (cmd === "/start" || cmd === "/yardim" || cmd === "/help") await sendTG(HELP);
    else if (cmd === "/hisse") {
      if (!sym) { await sendTG("Kullanım: /hisse SEMBOL (örn. /hisse AAPL)"); continue; }
      const live = (await liveQuotes([sym]))[sym] || null;
      const spy = await ctx.spy();
      const [a, nw] = await Promise.all([analyze(sym, { live, spyRet60: spy.ret60 }).catch(() => null), news(sym, 5).catch(() => [])]);
      const ai = a ? await aiComments([aiItem(a, { news: nw.map(n => n.headline).slice(0, 5) })]) : {};
      await sendTG(fmtDetail(a, nw) + (ai[sym] ? `\n\n🧠 Yorum (yapay zekâ): ${ai[sym]}` : ""), { buttons: a ? [[{ text: "📊 Opsiyon analizi", data: `/opsiyon ${sym}` }, { text: "👁 Takip et", data: `/takip ${sym}` }]] : null });
      if (a && chartsEnabled() && dailyCache.get(sym)?.length > 30) await sendPhoto(chartUrl(sym, dailyCache.get(sym), { stop: a.stopLoss, target: a.target1 }), `${sym} · son ~6 ay · 50g/200g ortalama${a.pick ? " · stop/hedef" : ""}`);
    } else if (cmd === "/opsiyon") {
      if (!sym) { await sendTG("Kullanım: /opsiyon SEMBOL (örn. /opsiyon NVDA)"); continue; }
      await sendTG(`⏳ ${sym} opsiyon zinciri analiz ediliyor…`);
      const res = await optionsFor(sym, ivStore, await ctx.r(), (await ctx.spy()).ret60).catch(e => ({ sym, error: e.message }));
      await sendTG(fmtAnalysis(res));
    } else if (cmd === "/karne") {
      await sendTG(fmtStats(stats(st.optBook || [])));
    } else if (cmd === "/takip") {
      if (!sym) { await sendTG("Kullanım: /takip SEMBOL (örn. /takip AAPL)"); continue; }
      const a = await analyze(sym, { live: (await liveQuotes([sym]))[sym] || null, spyRet60: (await ctx.spy()).ret60 }).catch(() => null);
      if (!a) { await sendTG(`⚠ ${sym}: veri alınamadı.`); continue; }
      await sendTG(addWatch(st, sym, a.price, nyDate())
        ? `👁 ${sym} takibe alındı ($${a.price}). SAT seçimi, 200g ortalama kırılımı ve zirveden −%8 geri çekilmede uyarı gelir.`
        : `${sym} zaten takipte.`);
    } else if (cmd === "/birak") {
      await sendTG(removeWatch(st, sym) ? `${sym} takipten çıkarıldı.` : `${sym || "?"} takipte değil.`);
    } else if (cmd === "/takiplerim") {
      await sendTG(fmtWatch(st));
    } else if (cmd === "/fikirkarne") {
      await sendTG(fmtIdeaReport(ctx.ideas));
    } else if (cmd === "/sabah") {
      await sendTG(fmtMorningBook(st.morning?.book) + (st.morning?.day ? `\nSon sabah mesajı: ${st.morning.day}` : ""));
    } else if (cmd === "/etf") {
      const lines = [];
      for (const s of ETFS_FAST) lines.push(fmtEtfState(s, etfState(await etfCloses(s))));
      lines.push(fmtFG(await getFG(st)));
      await sendTG(["⚡ SPY/QQQ KISA VADE (call alımı)", ...lines, "", fmtEtfBook(st)].join("\n"));
    } else if (cmd === "/portfoy") {
      const today = nyDate();
      const txt = st.model ? fmtModel(st.model, "💼 MODEL PORTFÖY — son 7 gün", shiftDays(today, -7)) : "Model portföy ilk tarama gününde başlar.";
      const paper = await paperSummary(st);
      await sendTG(txt + "\n\n" + fmtOptModel(st.om, shiftDays(today, -7)) + "\n\n" + fmtValue(st.vmodel, st.vmodel && periodStats(st.vmodel, shiftDays(today, -7)), "💎 DEĞER (UCUZ HİSSE) PORTFÖYÜ — son 7 gün") + (paper ? "\n\n" + paper : ""));
    } else if (cmd === "/spotkarne") {
      const today = nyDate();
      await sendTG(fmtSpotReport(spotScored(st), daysAgo(today, 30), "📈 SPOT SİNYAL KARNESİ — son 30 gün") +
        `\n(fiyatlar: son tarama ${st.lastPx?.at || "—"})`);
    } else if (cmd === "/sinyaller") {
      const ls = st.lastScan;
      if (!ls) await sendTG("Henüz tarama yok.");
      else await sendTG(fmtSignalList(ls));
    } else if (cmd === "/durum") {
      const ls = st.lastScan;
      await sendTG([
        "🤖 EAGLE-EYE US IQ — durum",
        `Evren: ${SYMS.length} hisse (S&P 500 + Nasdaq, likidite filtreli${UNI.updated ? ", " + UNI.updated.slice(0, 10) : ""})`,
        `Son tarama: ${ls ? ls.at : "yok"} · analiz edilen ${ls?.analyzed ?? 0}`,
        `Veri: ${st.data ? `${st.data.src} · canlı fiyat ${st.data.live}/${st.data.of} · medyan yaş ${st.data.medAgeMin ?? "—"} dk · ölçüm ${st.data.at}` : (alpacaEnabled() ? "Alpaca açık" : "Yahoo (gecikmeli)")}` +
          (st.data?.problem ? `\n⚠ ${st.data.problem}` : ""),
        "Kaynaklar: hisse canlı fiyat = Alpaca IEX · günlük mumlar = Alpaca SIP (15 dk gecikmeli; yoksa Yahoo) · opsiyon zinciri = Yahoo (~15 dk gecikmeli) · haber = Alpaca/Benzinga · Investing.com kullanılmaz.",
        `IV geçmişi: ${Object.keys(ivStore).length} sembol · son kayıt ${st.lastIvDay || "yok"}`,
        `AL kuralı: momentum en iyi %${Math.round((1 - CFG.MOM_TOP) * 100)} · zirvenin %${Math.round((1 - CFG.HI52_MAX) * 100)}–${Math.round((1 - CFG.HI52_MIN) * 100)} altı · hacim ≥ ${usd(CFG.MIN_DVOL / 1e6)}M`,
        `Opsiyon: yalnız alım · put ${OCFG.PUTS ? "açık" : "kapalı"} · çıkış ${OCFG.LONG_TP != null ? "+%" + Math.round(OCFG.LONG_TP * 100) : "hedefsiz"} / ${OCFG.LONG_SL != null ? "−%" + Math.round(OCFG.LONG_SL * 100) : "stopsuz"} / ${OCFG.LONG_DTE}g`,
        "", fmtFG(st.fg), "", fmtCalib(st.calib),
      ].join("\n"));
    }
  }
}

// ---------- Opsiyon: günlük fikirler ----------
// Yönlü adaylar: en güçlü AL/SAT sinyalleri (opsiyon likiditesi için yüksek hacimli olanlar).
// Nötr adaylar: endeks ETF'leri + yönsüz (ADX<20) en likit hisseler → oynaklık pahalıysa iron condor.
// Yalnız alım modunda nötr hisseler atlanır (yönsüz alım önerilmez) ve yönlü aday sayısı artırılır.
async function dailyOptionIdeas(signals, all, ivStore, r, spyRet60) {
  const liquid = a => a.dollarVol >= 150e6 && a.price >= 15;
  const [nAl, nSat] = OCFG.LONG_ONLY ? [14, OCFG.PUTS ? 10 : 0] : [10, 6];   // SAT adayları long put için (OPT_PUTS=0 ise taranmaz)
  const dirC = [...signals.filter(s => s.signal === "AL" && liquid(s)).slice(0, nAl), ...signals.filter(s => s.signal === "SAT" && liquid(s)).slice(0, nSat)];
  const neuC = OCFG.LONG_ONLY ? [] : all.filter(a => liquid(a) && (a.signal === "NÖTR" || a.adx < 20)).sort((a, b) => b.dollarVol - a.dollarVol).slice(0, 8);
  const etfSpots = await Promise.all(ETFS.map(s => analyze(s, { spyRet60 }).catch(() => null)));
  const cands = [...dirC, ...neuC, ...etfSpots.filter(Boolean)];
  const seen = new Set(), out = [];
  for (const spot of cands) {
    if (seen.has(spot.sym)) continue;
    seen.add(spot.sym);
    const res = await analyzeOptions(spot.sym, { spot, daily: dailyCache.get(spot.sym), r, hist: histOf(ivStore, spot.sym), top: 1 }).catch(() => null);
    if (res?.ideas?.[0]) out.push({ sym: spot.sym, idea: res.ideas[0], reasons: res.reasons });
  }
  out.sort((a, b) => b.idea.score - a.idea.score);
  return { ideas: diversify(out), scanned: seen.size };
}

// Yoğunlaşma koruması: hepsi aynı yönde/sektörde 6 fikir = tek bir büyük bahis. Aynı stratejiden en çok 3,
// aynı sektörden en çok 2, aynı yönden (yukarı/aşağı) en çok 4. Kurala uymayanlar GÖNDERİLMEZ
// (alternatif yoksa 6 yerine 3 fikir gitmesi, 6 kopya bahisten iyidir); /opsiyon ile tek tek bakılabilir.
export function diversify(list, n = 6) {
  const sec = s => UNI.meta?.[s]?.sec || "?";
  const cnt = { code: {}, sec: {}, dir: {} }, inc = (m, k) => (m[k] = (m[k] || 0) + 1);
  const ok = [];
  for (const x of list) {
    const d = x.idea.dir ?? 0, c = x.idea.code, s = sec(x.sym);
    if (ok.length < n && (cnt.code[c] || 0) < 3 && (s === "?" || (cnt.sec[s] || 0) < 2) && (d === 0 || (cnt.dir[d] || 0) < 4)) {
      ok.push(x); inc(cnt.code, c); inc(cnt.sec, s); inc(cnt.dir, d);
    }
  }
  return ok;
}

// ---------- Tarama kümesi ----------
// Alpaca varsa her run TAM evren (toplu veri, ~60 istek). Yoksa Yahoo istek sınırına takılmamak için:
// TAM tarama saatte bir; aradaki run'larda en likit CORE_N hisse + son taramanın sinyalleri.
function pickScanSet(st) {
  if (alpacaEnabled() || process.env.SYMBOLS) return { syms: SYMS, full: true };
  if (!st.lastFullScanTs || Date.now() - st.lastFullScanTs > 55 * 60e3) return { syms: SYMS, full: true };
  const core = SYMS.slice(0, +(process.env.CORE_N || 300));          // evren likiditeye göre sıralı
  const keep = (st.lastScan?.signals || []).map(s => s.sym);
  return { syms: [...new Set([...core, ...keep])], full: false };
}

// ---------- Ana ----------
export async function main() {
  const t0 = Date.now();
  const files = await loadFiles([STATE_FILE, IVHIST_FILE, IDEA_FILES.idx, IDEA_FILES.fast]);   // fikir dosyaları YALNIZ OKUNUR
  if (files === READ_FAILED) {                // durum bilinmiyor → hiçbir şey yazma, tekrar sinyal spam'i de yapma
    console.log("⚠ Gist okunamadı (geçici) — bu run atlandı, durum korunuyor.");
    return 0;
  }
  const st = files[STATE_FILE], ivStore = files[IVHIST_FILE];
  if (!gistEnabled()) console.log("ℹ Gist yapılandırılmamış — durum kalıcı değil (yerel test).");
  setMomCuts(st.momCuts);   // son tam taramanın momentum eşikleri (tek sembol analizi + çekirdek tarama için)
  let ivDirty = false;

  // --- ZİNCİR BOŞLUĞU: run.mjs normalde 7/24 ~10 dk'da bir çalışır. 45 dk'dan uzun sessizlik = bot durmuştu → haber ver ---
  if (gistEnabled() && st.lastRunTs && Date.now() - st.lastRunTs > 45 * 60e3) {
    const gm = Math.round((Date.now() - st.lastRunTs) / 60e3);
    await sendTG(`⚠ BOT ${gm >= 120 ? `${(gm / 60).toFixed(1)} SAAT` : `${gm} DK`} ÇALIŞMADI — son çalışma ${fmtTR(new Date(st.lastRunTs))} TR. ` +
      `Bu sürede sinyal/alarm kaçmış olabilir; şimdi yeniden çalışıyor.`);
  }
  st.lastRunTs = Date.now();

  // Tembel bağlam: komutlar gerektiğinde bir kez hesaplanır
  let _r = null, _spy = null;
  const ideaBooks = { idx: files[IDEA_FILES.idx], fast: files[IDEA_FILES.fast] };
  const ctx = { r: async () => (_r ??= await riskFreeRate()), spy: async () => (_spy ??= await spyReturn60()), ideas: ideaBooks };

  await handleCommands(st, ivStore, ctx);

  // --- AÇILIŞ ÖNCESİ (07:30–09:29 NY, işlem günü, günde 1): SPY/QQQ gün içi eğilim + hedef/stop ---
  await morningStep(st, ctx).catch(e => console.error("[Sabah]", e?.message || e));

  const open = await isMarketOpen();
  if (!open && !FORCE) {
    console.log("⏰ ABD piyasası kapalı — tarama yok.");
    await saveFiles({ [STATE_FILE]: st });
    return 3;
  }

  const today = nyDate(), { mins } = nyParts();
  const { syms: scanSyms, full } = pickScanSet(st);
  const [liveMap, spy] = await Promise.all([liveQuotes(scanSyms), ctx.spy()]);
  const { signals, analyzed, all, cuts } = await scanAll(scanSyms, { liveMap, spyRet60: spy.ret60 });
  if (full) st.lastFullScanTs = Date.now();
  if (cuts) st.momCuts = cuts;
  const spyPx = liveMap.SPY?.price ?? spy.rows?.at(-1)?.close ?? null;
  console.log(`Tarama (${full ? "TAM" : "çekirdek"}): ${analyzed}/${scanSyms.length} analiz · ${signals.length} sinyal · canlı fiyat ${Object.keys(liveMap).length} · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);

  // --- VERİ SAĞLIĞI: canlı fiyat kaç hissede geldi, ne kadar taze? Seans içinde sorun varsa günde 1 uyarı ---
  st.data = dataHealth(liveMap, scanSyms.length, open);
  // Seans içinde SPY çapraz kontrolü: Alpaca canlı fiyatı taze mi, Yahoo ile uyumlu mu?
  if (alpacaEnabled() && isRegularHours()) {
    const [alp, yq] = await Promise.all([liveQuotes(["SPY"]).then(m => m.SPY).catch(() => null), quoteNow("SPY").catch(() => null)]);
    st.data.cross = crossProblem(alp, yq);
    if (st.data.cross.problem && !st.data.problem) st.data.problem = st.data.cross.problem;
    console.log(`Çapraz kontrol SPY: Alpaca ${st.data.cross.alpaca ?? "—"} (${st.data.cross.ageMin ?? "—"} dk) · Yahoo ${st.data.cross.yahoo ?? "—"} · fark %${st.data.cross.diffPct ?? "—"}`);
  }
  console.log(`Veri: ${st.data.src} · canlı ${st.data.live}/${st.data.of} · medyan yaş ${st.data.medAgeMin ?? "—"} dk`);
  if (st.data.problem && st.dataWarnDay !== today && isRegularHours()) {
    st.dataWarnDay = today;
    await sendTG(`⚠ VERİ UYARISI — ${st.data.problem}\nSinyaller gecikmeli/eksik fiyatla üretilmiş olabilir. Kaynak: ${st.data.src}.`);
  }

  // --- Spot sinyalleri: aynı gün aynı sinyali tekrar gönderme ---
  if (!st.sent || st.sent.date !== today) st.sent = { date: today, map: {}, n: { AL: 0, SAT: 0 } };
  // Faz 7: kalite + sektör rotasyonu → AL/SAT öncelik sırası ve etiketleri (sinyal silinmez)
  await rankEdge(st, signals, { secOf: s => UNI.meta?.[s]?.sec || null, closesOf: async e => (await fetchDaily(e)).map(r => r.close), qualityStats, today })
    .catch(e => console.error("[Faz7]", e?.message || e));
  const fresh = pickFresh(signals, st.sent);
  const held = signals.filter(x => st.sent.map[x.sym] !== x.signal).length;   // kota yüzünden bekleyenler
  const firstOfDay = st.lastHeaderDay !== today;
  if (fresh.length || firstOfDay) {
    // Haber duygusu (son 48 saat başlıkları) — yalnız BİLGİ etiketi, kurala girmez (research/news.mjs ölçümüne kadar)
    if (alpacaEnabled()) for (const s of fresh) {
      const t = newsTag(newsSentiment(await news(s.sym, 20).catch(() => []), Date.now() - 2 * 864e5));
      if (t) s.edgeTag = s.edgeTag ? `${s.edgeTag} · ${t}` : t;
    }
    const al = fresh.filter(s => s.signal === "AL"), sat = fresh.filter(s => s.signal === "SAT");
    let m = `🇺🇸 ABD SPOT SİNYALLERİ${firstOfDay ? " — seans açılışı" : " — yeni"}\n${fmtTR()} (TR) · SPY 60g ${sgn(spy.ret60)}%\n` +
      (firstOfDay ? `AL = momentum lideri geri çekilmede (ufuk ~1 ay; stop/hedef/21 gün dolunca ÇIKIŞ mesajı gelir) · SAT = teyitli düşüş + zayıf momentum\nBoyut: stop'a kadar portföyün %${RISK_SPOT * 100}'i riske, tek hisse en çok %${MAX_POS * 100} · sektör başına en çok ${SEC_CAP}\n` : "");
    // Kesme YOK: liste zaten günlük kotayla sınırlı; uzun mesaj sendTG'de satır sınırından parçalanır.
    if (al.length) m += `\nAL (${al.length})\n` + al.map(fmtSignal).join("\n") + "\n";
    if (sat.length) m += `\nSAT (${sat.length})\n` + sat.map(fmtSignal).join("\n") + "\n";
    if (!al.length && !sat.length) m += "\nFiltreyi geçen yeni sinyal yok.\n";
    if (analyzed === 0) m += "\n⚠ Hiçbir sembol analiz edilemedi — veri kaynağı sorunu olabilir.\n";
    if (held) m += `\n(+${held} sinyal daha filtreyi geçti; günlük kota AL ${DAY_CAP.AL} / SAT ${DAY_CAP.SAT}, sektör başına ${SEC_CAP} — liste: /sinyaller)\n`;
    const ai = await aiComments(fresh.map(x => aiItem(x, { sector: UNI.meta?.[x.sym]?.sec })));
    if (Object.keys(ai).length) m += `\n🧠 Yorum (yapay zekâ · ${AI_MODEL} · yalnız yukarıdaki metriklere dayanır)\n` + Object.entries(ai).map(([k, v]) => `• ${k}: ${v}`).join("\n") + "\n";
    m += `\n${analyzed}/${SYMS.length} hisse tarandı · SAT = spotta çık/girme · ${DISCLAIMER}`;
    const btn = fresh.slice(0, 16).map(s => ({ text: `${s.signal === "AL" ? "🟢" : "🔴"} ${s.sym}`, data: `/hisse ${s.sym}` }));
    if (await sendTG(m, { buttons: Array.from({ length: Math.ceil(btn.length / 4) }, (_, k) => btn.slice(k * 4, k * 4 + 4)) })) {
      st.lastHeaderDay = today;
      logSignals((st.spotBook ||= []), fresh, today, spyPx);           // canlı spot karnesi
      st.om ||= initOptModel(today);                                     // 3 aylık kol: en iyi 2 AL (call) + en iyi SAT (put)
      fresh.filter(x => x.signal === "AL").slice(0, 4).forEach(x => queue(st.om, today, "Q", x.sym, "C", "spot AL"));   // likit olan ilk 2 alınır
      fresh.filter(x => x.signal === "SAT").slice(0, 2).forEach(x => queue(st.om, today, "Q", x.sym, "P", "spot SAT"));  // likit olan ilk 1 alınır
    } else {
      // Gönderilemeyen sinyaller "gönderildi" sayılmaz → sonraki run'da tekrar denenir (kaybolmaz).
      for (const s of fresh) {
        delete st.sent.map[s.sym]; st.sent.n[s.signal]--;
        const sec = UNI.meta?.[s.sym]?.sec, sk = sec && `${s.signal}|${sec}`;
        if (sk && st.sent.sec?.[sk]) st.sent.sec[sk]--;
      }
      console.error(`⚠ Spot mesajı gönderilemedi — ${fresh.length} sinyal sonraki run'da tekrar denenecek.`);
    }
  } else console.log("Yeni spot sinyali yok — mesaj gönderilmedi.");

  // --- TAKİP LİSTESİ uyarıları ---
  if (Object.keys(st.watch || {}).length) {
    const alerts = checkWatch(st, new Map(all.map(a => [a.sym, a])), today);
    if (alerts.length) await sendTG("👁 TAKİP UYARISI\n\n" + alerts.join("\n") + `\n\n${DISCLAIMER}`);
  }

  // --- MODEL PORTFÖY (sanal): AL seçimleri → 15 slot, eşit ağırlık; çıkış stop/hedef/21 gün; günlük özsermaye ---
  {
    const px = new Map(all.map(a => [a.sym, a.price]));
    st.model ||= initModel(today, spyPx);
    const newAls = (fresh || []).filter(s => s.signal === "AL" && st.sent.map[s.sym] === "AL");
    const { bought, sold } = stepModel(st.model, today, newAls, s => px.get(s), spyPx);
    if (bought.length || sold.length) {
      const L = ["💼 MODEL PORTFÖY — işlem"];
      for (const b of bought) L.push(`🟢 ALINDI ${b.sym} $${b.px} (~$${b.alloc.toLocaleString("en-US")})`);
      for (const s of sold) L.push(`${s.ret >= 0 ? "✅" : "❌"} SATILDI ${s.sym} · ${s.why} · ${s.td} gün · ${(s.ret * 100).toFixed(1)}% ($${s.pnl})`);
      L.push(`Açık ${Object.keys(st.model.pos).length}/${MCFG.SLOTS} · özsermaye $${Math.round(equity(st.model, s => px.get(s))).toLocaleString("en-US")}`);
      await sendTG(L.join("\n"));
    }
    // AYLIK / 3 AYLIK RAPOR: yeni ayın (çeyreğin) ilk işlem günü 10:00 NY sonrası, önceki dönemi özetler
    if (mins >= 600 || process.env.MODEL_REPORT_FORCE === "1") {
      const { out, ym, q } = dueReports(st.model, today);
      const pxOf = s => px.get(s);
      if (out.includes("monthly") || process.env.MODEL_REPORT_FORCE === "1") {
        const end = prevMonthEnd(today);
        if (await sendTG(fmtModel(st.model, `📆 MODEL PORTFÖY — AYLIK RAPOR (${end.slice(0, 7)})`, prevMonthEnd(end), pxOf, end) + "\n\n" + fmtOptModel(st.om, prevMonthEnd(end), end) + "\n\n" + fmtValue(st.vmodel, st.vmodel && periodStats(st.vmodel, prevMonthEnd(end), end), "💎 DEĞER (UCUZ HİSSE) PORTFÖYÜ — aylık"))) st.model.lastMonthly = ym;
      }
      if (out.includes("quarterly") || process.env.MODEL_REPORT_FORCE === "1") {
        const end = prevQuarterEnd(today);
        if (await sendTG(fmtModel(st.model, `🗓 MODEL PORTFÖY — 3 AYLIK RAPOR (${end.slice(0, 7)} sonu)`, prevQuarterEnd(end), pxOf, end) + "\n\n" + fmtOptModel(st.om, prevQuarterEnd(end), end) + "\n\n" + fmtValue(st.vmodel, st.vmodel && periodStats(st.vmodel, prevQuarterEnd(end), end), "💎 DEĞER (UCUZ HİSSE) PORTFÖYÜ — 3 aylık"))) st.model.lastQuarterly = q;
      }
    }
  }

  // --- DEĞER (UCUZ HİSSE) PORTFÖYÜ: yeni ayın ilk işlem günü (10:00 NY sonrası) dengeleme, her turda değerleme ---
  if (full) await valueStep(st, today, mins, all, spyPx).catch(e => console.error("[Değer]", e?.message || e));

  // --- ALPACA PAPER (isteğe bağlı, PAPER_TRADE=1): aynı AL'leri gerçek dolumla sanal hesapta uygula ---
  if (paperEnabled()) {
    const newAls = (fresh || []).filter(s => s.signal === "AL" && st.sent.map[s.sym] === "AL");
    const lines = await runPaper(st, today, newAls, tradingDays, { risk: RISK_SPOT, maxPos: MAX_POS, hold: HOLD_DAYS });
    if (lines.length) await sendTG("💼 MODEL PORTFÖY (paper)\n" + lines.join("\n"));
  }

  // --- SPOT ÇIKIŞLARI: kayıtlı AL'lerde stop / hedef / 21 işlem günü; SAT'larda 21 gün sonucu ---
  if (st.spotBook?.length) {
    const px = new Map(all.map(a => [a.sym, a.price]));
    const exits = checkExits(st.spotBook, today, s => px.get(s), spyPx);
    if (exits.length && !(await sendTG(fmtExits(exits) + `\n\nℹ Fiyatlar tarama anındaki son fiyattır. ${DISCLAIMER}`))) {
      exits.forEach(b => { delete b.closed; });                       // gönderilemedi → sonraki run'da tekrar
    }
  }
  // /sinyaller için filtreyi geçen TÜM sinyaller (kısa alanlarla — Gist boyutu küçük kalsın)
  st.lastScan = { at: fmtTR(), analyzed, signals: signals.map(compactSignal) };

  // --- CANLI KALİBRASYON: kapanmış spot sinyallerinden yön avantajı (günde 1) → opsiyon motoruna ---
  if (st.calib?.at !== today) st.calib = calibrate(st.spotBook, today);
  setEdges(st.calib);

  // --- Opsiyon fikirleri: günde 2 kez (10:15 ve 14:00 NY; açılış spread'leri geniş olduğu için 10:15) ---
  const slot = mins >= 840 ? "PM" : mins >= 615 ? "AM" : null;
  const optKey = slot && `${today}-${slot}`;
  if ((optKey && st.lastOptKey !== optKey) || process.env.OPT_FORCE === "1") {
    const t1 = Date.now();
    const r = await ctx.r();
    const { ideas, scanned } = await dailyOptionIdeas(signals, all, ivStore, r, spy.ret60);
    st.lastOptKey = optKey;
    addIdeas((st.optBook ||= []), ideas.slice(0, 6), today);          // karneye kaydet (vade sonunda ölçülecek)
    await sendTG(fmtDailyIdeas(ideas.slice(0, 6), `🎯 ABD OPSİYON FİKİRLERİ — ${slot === "PM" ? "öğleden sonra" : "sabah"}\n${fmtTR()} (TR) · ${scanned} dayanak incelendi · risksiz faiz %${(r * 100).toFixed(2)}`),
      { buttons: [ideas.slice(0, 6).map(x => ({ text: `📊 ${x.sym}`, data: `/opsiyon ${x.sym}` }))] });
    console.log(`Opsiyon: ${ideas.length} fikir · ${((Date.now() - t1) / 1e3).toFixed(0)}s`);
  }

  // --- Karne: vadesi geçen fikirleri sonuçlandır (günde 1) ---
  if (st.optBook?.length && st.lastSettleDay !== today) {
    st.lastSettleDay = today;
    const done = await settle(st.optBook, today, async (sym, exp) => {
      const d = dailyCache.get(sym) || (await fetchDaily(sym));
      const bar = d.filter(b => nyDate(new Date(b.ts)) <= exp).pop();
      return bar ? bar.close : null;
    });
    if (done.length) {
      const lines = done.map(b => `${b.pnl >= 0 ? "✅" : "❌"} ${b.sym} ${b.code} (${b.exp}) → vade kapanışı $${b.close} · vadeye kadar tutulsaydı K/Z ${b.pnl >= 0 ? "+" : ""}$${b.pnl}` +
        (b.closed && b.closed.reason !== "vade" ? ` (kurallarla ${b.closed.d} kapandı: ${b.closed.pnl >= 0 ? "+" : ""}$${b.closed.pnl})` : "") +
        ` · tahmini EV +$${b.ev}, POP %${Math.round(b.pop * 100)}`);
      await sendTG("📒 Vadesi dolan opsiyon fikirleri (model kalibrasyonu)\n\n" + lines.join("\n") + "\n\n" + fmtStats(stats(st.optBook)));
    }
  }

  // --- Karne: açık fikirleri canlı fiyatla değerle, yönetim kurallarını uygula (günde 1, 15:00 NY sonrası) ---
  if (st.optBook?.length && ((mins >= 900 && st.lastMarkDay !== today) || process.env.MARK_FORCE === "1")) {
    st.lastMarkDay = today;
    const { marked, closed } = await markBook(st.optBook, today, async (sym, expTs) => {
      const c = await optionChain(sym, expTs);
      return c && c.exp === expTs ? { S: c.quote.price, calls: c.calls, puts: c.puts } : null;
    });
    console.log(`Karne değerleme: ${marked} açık fikir · ${closed.length} kural tetiklendi`);
    if (closed.length) await sendTG("📕 OPSİYON FİKRİ KAPAT — yönetim kuralı tetiklendi\n\n" + closed.map(fmtClosed).join("\n") +
      "\n\nℹ Fiyat: bugünkü canlı alış/satış (orta ± %30 spread). Kendi pozisyonunu canlı fiyatla kontrol et.\n\n" + fmtStats(stats(st.optBook)));
  }

  // --- Spot karnesi için güncel fiyatlar (yalnız kayıtlı sinyallerin hisseleri) ---
  if (st.spotBook?.length) {
    const px = new Map(all.map(a => [a.sym, a.price]));
    st.lastPx = { at: today, spy: spyPx, p: Object.fromEntries([...new Set(st.spotBook.map(b => b.sym))].map(s => [s, px.get(s) ?? st.lastPx?.p?.[s] ?? null])) };
  }

  // --- HAFTALIK RAPOR: Cuma 15:30 NY sonrası (TR 23:30), haftada 1 ---
  const { wd } = nyParts();
  if ((wd === "Fri" && mins >= 930 && st.lastWeekly !== today) || process.env.WEEKLY_FORCE === "1") {
    st.lastWeekly = today;
    await sendTG(weeklyReport(st, today, await paperSummary(st), fmtIdeaReport(ideaBooks)));
    if (st.model) {
      const px = new Map(all.map(a => [a.sym, a.price]));
      await sendTG(fmtModel(st.model, `📊 MODEL PORTFÖY — HAFTALIK RAPOR (${today})`, shiftDays(today, -7), s => px.get(s)) + "\n\n" + fmtOptModel(st.om, shiftDays(today, -7)) + "\n\n" + fmtValue(st.vmodel, st.vmodel && periodStats(st.vmodel, shiftDays(today, -7)), "💎 DEĞER (UCUZ HİSSE) PORTFÖYÜ — haftalık"));
    }
  }

  // --- SPY/QQQ KISA VADE CALL: 15:30 NY sonrası günde 1 (kapanışa yakın gir/çık) ---
  if (mins >= 930 || process.env.ETF_FORCE === "1") {
    const r = await ctx.r();
    const fgNow = await getFG(st, true);
    const lines = await runEtf(st, {
      today, closesFor: etfCloses, fg: fgNow?.fg ?? null,
      chainFor: async (sym, expTs = null) => expTs
        ? loadChain(sym, r, { minDte: 0, maxDte: 400, targets: [Math.max(0, (expTs - Date.now() / 1e3) / 86400)] })
        : loadChain(sym, r, { minDte: ETF_OPT.DTE, maxDte: ETF_OPT.DTE + 30, targets: [ETF_OPT.DTE + 2] }),
    });
    for (const l of lines) await sendTG(l + `\n\n${DISCLAIMER}`, { buttons: [[{ text: "⚡ SPY/QQQ durumu", data: "/etf" }]] });
    st.om ||= initOptModel(today);                                       // aylık kol: bugün açılan ETF fırsatları
    for (const p of Object.values(st.etf?.pos || {})) if (p.d === today && !p.omq) { queue(st.om, today, "M", p.sym, p.type || "C", `ETF ${p.kind || "rsi"}`); p.omq = true; }
  }

  // --- OPSİYON MODEL PORTFÖYLERİ (haftalık / aylık / 3 aylık kol): girişler her turda, değerleme+çıkış günde 1 ---
  if (st.om && (open || FORCE)) {
    const r = await ctx.r();
    const bought = st.om.pending.length ? await enterPending(st.om, today, (sym, lo, hi) => loadChain(sym, r, { minDte: lo, maxDte: hi, targets: [(lo + hi) / 2] })) : [];
    let sold = [];
    if ((mins >= 900 && st.om.markDay !== today) || process.env.MARK_FORCE === "1") {
      st.om.markDay = today;
      sold = await markAndExit(st.om, today, async p => {
        const c = await optionChain(p.sym, p.expTs);
        if (!c || c.exp !== p.expTs) return null;
        const o = (p.type === "P" ? c.puts : c.calls).find(x => x.sym === p.occ) || (p.type === "P" ? c.puts : c.calls).find(x => x.strike === p.K);
        return o && o.bid >= 0 && o.ask > 0 ? { mid: (o.bid + o.ask) / 2, bid: o.bid, ask: o.ask } : null;
      });
    }
    if (bought.length || sold.length) await sendTG(fmtOptTrades(bought, sold));
  }

  // --- IV geçmişi: günde 1 (15:00 NY sonrası) → IV rank zamanla oluşur ---
  if ((mins >= 900 && st.lastIvDay !== today) || process.env.IV_FORCE === "1") {
    const t2 = Date.now();
    const top = [...ETFS, ...UNI.symbols.slice(0, +(process.env.IV_TOP || 250))];
    const n = await snapshot(ivStore, [...new Set(top)], today, await ctx.r());
    st.lastIvDay = today; ivDirty = true;
    console.log(`IV geçmişi: ${n}/${top.length} kaydedildi · ${((Date.now() - t2) / 1e3).toFixed(0)}s`);
  }

  const trimmed = trimState(st);
  if (trimmed) console.log(`Durum dosyası budandı: ${trimmed} eski kapanmış kayıt silindi.`);
  await saveFiles(ivDirty ? { [STATE_FILE]: st, [IVHIST_FILE]: ivStore } : { [STATE_FILE]: st });
  console.log(`Bitti · ${((Date.now() - t0) / 1e3).toFixed(1)}s`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().then(code => process.exit(code)).catch(async e => {
    console.error("FATAL:", e);
    try { await sendTG("⚠ EAGLE-EYE US IQ HATASI: " + (e?.message || e)); } catch {}
    process.exit(1);
  });
}
