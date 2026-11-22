#!/usr/bin/env node
// ABD BOT — spot tarama + opsiyon öneri motoru → Telegram.
// GitHub Actions'ta 20 dk'da bir çalışır; durum Gist'te. Bağımlılıksız (Node 20+ ESM).
//
// Çıkış kodları: 0 = tamam · 3 = piyasa kapalı (workflow döngüsü durur) · 1 = hata
// Ortam: TG_TOKEN TG_CHAT GH_GIST_TOKEN GIST_ID [ALPACA_KEY_ID ALPACA_SECRET_KEY]
//        DRY_RUN=1 (Telegram'a gönderme) · FORCE=1 (piyasa kapalıyken de tara) · SYMBOLS=AAPL,MSFT (alt küme)
//        OPT_FORCE=1 (opsiyon fikirlerini saat beklemeden üret) · IV_FORCE=1 (IV geçmişi kaydını zorla)
//        MARK_FORCE=1 (karnedeki açık fikirleri saat beklemeden değerle)
import { scanAll, analyze, spyReturn60, loadUniverse, dailyCache, CFG } from "../spot/scan.mjs";
import { liveQuotes, alpacaEnabled } from "../data/alpaca.mjs";
import { isMarketOpen, nyDate, nyParts, fmtTR } from "../data/market.mjs";
import { riskFreeRate, fetchDaily, optionChain } from "../data/yahoo.mjs";
import { loadFiles, saveFiles, READ_FAILED, gistEnabled, STATE_FILE, IVHIST_FILE } from "./state.mjs";
import { sendTG, fetchCommands } from "./telegram.mjs";
import { analyzeOptions, OCFG } from "../options/engine.mjs";
import { fmtAnalysis, fmtDailyIdeas } from "../options/format.mjs";
import { histOf, snapshot } from "../options/ivhist.mjs";
import { addIdeas, settle, stats, fmtStats, markBook, fmtClosed } from "../options/book.mjs";
import { pathToFileURL } from "node:url";

const UNI = loadUniverse();
const SYMS = process.env.SYMBOLS ? process.env.SYMBOLS.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : UNI.symbols;
const FORCE = process.env.FORCE === "1";
const ETFS = ["SPY", "QQQ", "IWM"];                       // nötr (iron condor) fikirleri için endeks ETF'leri
const usd = v => (v == null ? "—" : "$" + (+v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const sgn = v => (v >= 0 ? "+" : "") + v;
const DISCLAIMER = "⚠ Yatırım tavsiyesi değildir.";

// Günlük üst sınır: filtreyi geçenlerden yalnızca en kaliteli ilk N yeni sinyal gönderilir (gürültü freni).
export const DAY_CAP = { AL: +(process.env.MAX_AL_DAY || 10), SAT: +(process.env.MAX_SAT_DAY || 6) };
// signals kalite sırasıyla gelir (scanAll). Aynı gün aynı sinyal tekrar gönderilmez; kota dolunca kalanlar bekler.
export function pickFresh(signals, sent, cap = DAY_CAP) {
  sent.n ||= { AL: 0, SAT: 0 };
  const out = [];
  for (const s of signals) {
    if (sent.map[s.sym] === s.signal) continue;
    if ((sent.n[s.signal] || 0) >= (cap[s.signal] ?? 0)) continue;
    sent.map[s.sym] = s.signal; sent.n[s.signal] = (sent.n[s.signal] || 0) + 1; out.push(s);
  }
  return out;
}

// ---------- Mesaj biçimleri ----------
export function fmtSignal(a) {
  const icon = a.signal === "AL" ? "🟢" : "🔴";
  const parts = [`${icon} ${a.sym} ${usd(a.price)}`, `güven %${a.confidence}`, `ADX ${a.adx}`];
  if (a.rsi != null) parts.push(`RSI ${a.rsi}`);
  parts.push(`RS60 ${sgn(a.rs60)}`);
  if (a.stopLoss) parts.push(`stop ${usd(a.stopLoss)}`);
  if (a.target1) parts.push(`hedef ${usd(a.target1)}`);
  if (a.rr) parts.push(`R:R ${a.rr}`);
  if (a.dip) parts.push("DİP");
  return parts.join(" · ");
}

const SIG_KEYS = ["sym", "signal", "price", "confidence", "adx", "rsi", "rs60", "stopLoss", "target1", "rr", "dip"];
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

export function fmtDetail(a) {
  if (!a) return "Veri alınamadı (sembol hatalı olabilir).";
  const L = [
    `🔎 ${a.sym} — ${usd(a.price)}${a.live ? " (canlı · IEX)" : " (Yahoo)"}`,
    `Sinyal: ${a.signal} · güven %${a.confidence}${a.mod ? " · " + a.mod : ""}`,
    `Trend (haftalık): ${a.htf || "?"}${a.htfNote ? " · " + a.htfNote : ""}`,
    `ADX ${a.adx} · RSI ${a.rsi ?? "—"} · ATR ${a.atr ?? "—"}`,
    `60g getiri ${sgn(a.ret60)}% · SPY'a göre ${sgn(a.rs60)}%`,
    `Hacim temposu ${a.volPace}× · ort. işlem hacmi ${usd(Math.round(a.dollarVol / 1e6))}M`,
  ];
  if (a.stopLoss || a.target1) L.push(`Stop ${usd(a.stopLoss)} · Hedef1 ${usd(a.target1)} · Hedef2 ${usd(a.target2)} · R:R ${a.rr || "—"}`);
  if (a.entryHint) L.push(`Giriş: ${a.entryHint}`);
  if (Array.isArray(a.waitReasons) && a.waitReasons.length) L.push(`Bekleme nedenleri: ${a.waitReasons.slice(0, 3).join(" · ")}`);
  L.push("", "Opsiyon yapıları için: /opsiyon " + a.sym, DISCLAIMER);
  return L.join("\n");
}

const HELP = [
  "🇺🇸 ABD BOT komutları",
  "/hisse SEMBOL — teknik analiz (örn. /hisse NVDA)",
  "/opsiyon SEMBOL — oynaklık panosu + en iyi 3 opsiyon yapısı (örn. /opsiyon AAPL)",
  "/sinyaller — son taramanın AL/SAT listesi",
  "/karne — gönderilen opsiyon fikirlerinin gerçekleşen sonuçları (model isabeti)",
  "/durum — bot durumu",
  "/yardim — bu liste",
].join("\n");

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
      await sendTG(fmtDetail(await analyze(sym, { live, spyRet60: spy.ret60 }).catch(() => null)));
    } else if (cmd === "/opsiyon") {
      if (!sym) { await sendTG("Kullanım: /opsiyon SEMBOL (örn. /opsiyon NVDA)"); continue; }
      await sendTG(`⏳ ${sym} opsiyon zinciri analiz ediliyor…`);
      const res = await optionsFor(sym, ivStore, await ctx.r(), (await ctx.spy()).ret60).catch(e => ({ sym, error: e.message }));
      await sendTG(fmtAnalysis(res));
    } else if (cmd === "/karne") {
      await sendTG(fmtStats(stats(st.optBook || [])));
    } else if (cmd === "/sinyaller") {
      const ls = st.lastScan;
      if (!ls) await sendTG("Henüz tarama yok.");
      else await sendTG(fmtSignalList(ls));
    } else if (cmd === "/durum") {
      const ls = st.lastScan;
      await sendTG([
        "🤖 ABD BOT — durum",
        `Evren: ${SYMS.length} hisse (S&P 500 + Nasdaq, likidite filtreli${UNI.updated ? ", " + UNI.updated.slice(0, 10) : ""})`,
        `Son tarama: ${ls ? ls.at : "yok"} · analiz edilen ${ls?.analyzed ?? 0}`,
        `Canlı fiyat (Alpaca IEX): ${alpacaEnabled() ? "açık" : "kapalı — Yahoo kullanılıyor"}`,
        `IV geçmişi: ${Object.keys(ivStore).length} sembol · son kayıt ${st.lastIvDay || "yok"}`,
        `Spot filtre: güven ≥ ${CFG.MIN_CONF} · ADX ≥ ${CFG.MIN_ADX} · hacim ≥ ${usd(CFG.MIN_DVOL / 1e6)}M`,
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
  const [nAl, nSat] = OCFG.LONG_ONLY ? [14, 10] : [10, 6];
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
  const files = await loadFiles([STATE_FILE, IVHIST_FILE]);
  if (files === READ_FAILED) {                // durum bilinmiyor → hiçbir şey yazma, tekrar sinyal spam'i de yapma
    console.log("⚠ Gist okunamadı (geçici) — bu run atlandı, durum korunuyor.");
    return 0;
  }
  const st = files[STATE_FILE], ivStore = files[IVHIST_FILE];
  if (!gistEnabled()) console.log("ℹ Gist yapılandırılmamış — durum kalıcı değil (yerel test).");
  let ivDirty = false;

  // Tembel bağlam: komutlar gerektiğinde bir kez hesaplanır
  let _r = null, _spy = null;
  const ctx = { r: async () => (_r ??= await riskFreeRate()), spy: async () => (_spy ??= await spyReturn60()) };

  await handleCommands(st, ivStore, ctx);

  const open = await isMarketOpen();
  if (!open && !FORCE) {
    console.log("⏰ ABD piyasası kapalı — tarama yok.");
    await saveFiles({ [STATE_FILE]: st });
    return 3;
  }

  const today = nyDate(), { mins } = nyParts();
  const { syms: scanSyms, full } = pickScanSet(st);
  const [liveMap, spy] = await Promise.all([liveQuotes(scanSyms), ctx.spy()]);
  const { signals, analyzed, all } = await scanAll(scanSyms, { liveMap, spyRet60: spy.ret60 });
  if (full) st.lastFullScanTs = Date.now();
  console.log(`Tarama (${full ? "TAM" : "çekirdek"}): ${analyzed}/${scanSyms.length} analiz · ${signals.length} sinyal · canlı fiyat ${Object.keys(liveMap).length} · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);

  // --- Spot sinyalleri: aynı gün aynı sinyali tekrar gönderme ---
  if (!st.sent || st.sent.date !== today) st.sent = { date: today, map: {}, n: { AL: 0, SAT: 0 } };
  const fresh = pickFresh(signals, st.sent);
  const held = signals.filter(x => st.sent.map[x.sym] !== x.signal).length;   // kota yüzünden bekleyenler
  const firstOfDay = st.lastHeaderDay !== today;
  if (fresh.length || firstOfDay) {
    const al = fresh.filter(s => s.signal === "AL"), sat = fresh.filter(s => s.signal === "SAT");
    let m = `🇺🇸 ABD SPOT SİNYALLERİ${firstOfDay ? " — seans açılışı" : " — yeni"}\n${fmtTR()} (TR) · SPY 60g ${sgn(spy.ret60)}%\n`;
    // Kesme YOK: liste zaten günlük kotayla sınırlı; uzun mesaj sendTG'de satır sınırından parçalanır.
    if (al.length) m += `\nAL (${al.length})\n` + al.map(fmtSignal).join("\n") + "\n";
    if (sat.length) m += `\nSAT (${sat.length})\n` + sat.map(fmtSignal).join("\n") + "\n";
    if (!al.length && !sat.length) m += "\nFiltreyi geçen yeni sinyal yok.\n";
    if (analyzed === 0) m += "\n⚠ Hiçbir sembol analiz edilemedi — veri kaynağı sorunu olabilir.\n";
    if (held) m += `\n(+${held} sinyal daha filtreyi geçti; günlük kota AL ${DAY_CAP.AL} / SAT ${DAY_CAP.SAT} — liste: /sinyaller)\n`;
    m += `\n${analyzed}/${SYMS.length} hisse tarandı · SAT = spotta çık/girme · ${DISCLAIMER}`;
    if (await sendTG(m)) st.lastHeaderDay = today;
    else {
      // Gönderilemeyen sinyaller "gönderildi" sayılmaz → sonraki run'da tekrar denenir (kaybolmaz).
      for (const s of fresh) { delete st.sent.map[s.sym]; st.sent.n[s.signal]--; }
      console.error(`⚠ Spot mesajı gönderilemedi — ${fresh.length} sinyal sonraki run'da tekrar denenecek.`);
    }
  } else console.log("Yeni spot sinyali yok — mesaj gönderilmedi.");
  // /sinyaller için filtreyi geçen TÜM sinyaller (kısa alanlarla — Gist boyutu küçük kalsın)
  st.lastScan = { at: fmtTR(), analyzed, signals: signals.map(compactSignal) };

  // --- Opsiyon fikirleri: günde 2 kez (10:15 ve 14:00 NY; açılış spread'leri geniş olduğu için 10:15) ---
  const slot = mins >= 840 ? "PM" : mins >= 615 ? "AM" : null;
  const optKey = slot && `${today}-${slot}`;
  if ((optKey && st.lastOptKey !== optKey) || process.env.OPT_FORCE === "1") {
    const t1 = Date.now();
    const r = await ctx.r();
    const { ideas, scanned } = await dailyOptionIdeas(signals, all, ivStore, r, spy.ret60);
    st.lastOptKey = optKey;
    addIdeas((st.optBook ||= []), ideas.slice(0, 6), today);          // karneye kaydet (vade sonunda ölçülecek)
    await sendTG(fmtDailyIdeas(ideas.slice(0, 6), `🎯 ABD OPSİYON FİKİRLERİ — ${slot === "PM" ? "öğleden sonra" : "sabah"}\n${fmtTR()} (TR) · ${scanned} dayanak incelendi · risksiz faiz %${(r * 100).toFixed(2)}`));
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

  // --- IV geçmişi: günde 1 (15:00 NY sonrası) → IV rank zamanla oluşur ---
  if ((mins >= 900 && st.lastIvDay !== today) || process.env.IV_FORCE === "1") {
    const t2 = Date.now();
    const top = [...ETFS, ...UNI.symbols.slice(0, +(process.env.IV_TOP || 250))];
    const n = await snapshot(ivStore, [...new Set(top)], today, await ctx.r());
    st.lastIvDay = today; ivDirty = true;
    console.log(`IV geçmişi: ${n}/${top.length} kaydedildi · ${((Date.now() - t2) / 1e3).toFixed(0)}s`);
  }

  await saveFiles(ivDirty ? { [STATE_FILE]: st, [IVHIST_FILE]: ivStore } : { [STATE_FILE]: st });
  console.log(`Bitti · ${((Date.now() - t0) / 1e3).toFixed(1)}s`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().then(code => process.exit(code)).catch(async e => {
    console.error("FATAL:", e);
    try { await sendTG("⚠ ABD BOT HATASI: " + (e?.message || e)); } catch {}
    process.exit(1);
  });
}
