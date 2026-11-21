#!/usr/bin/env node
// ABD BOT — Faz 1: spot tarama → Telegram sinyalleri + komutlar.
// GitHub Actions'ta 20 dk'da bir çalışır; durum Gist'te. Bağımlılıksız (Node 20+ ESM).
//
// Çıkış kodları: 0 = tamam · 3 = piyasa kapalı (workflow döngüsü durur) · 1 = hata
// Ortam: TG_TOKEN TG_CHAT GH_GIST_TOKEN GIST_ID [ALPACA_KEY_ID ALPACA_SECRET_KEY]
//        DRY_RUN=1 (Telegram'a gönderme) · FORCE=1 (piyasa kapalıyken de tara) · SYMBOLS=AAPL,MSFT (alt küme)
import { scanAll, analyze, spyReturn60, CFG } from "../spot/scan.mjs";
import { liveQuotes, alpacaEnabled } from "../data/alpaca.mjs";
import { isMarketOpen, nyDate, fmtTR } from "../data/market.mjs";
import { loadState, saveState, READ_FAILED, gistEnabled } from "./state.mjs";
import { sendTG, fetchCommands } from "./telegram.mjs";
import ALL from "../spot/symbols.json" with { type: "json" };
import { pathToFileURL } from "node:url";

const SYMS = process.env.SYMBOLS ? process.env.SYMBOLS.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : ALL;
const FORCE = process.env.FORCE === "1";
const usd = v => (v == null ? "—" : "$" + (+v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const sgn = v => (v >= 0 ? "+" : "") + v;
const DISCLAIMER = "⚠ Yatırım tavsiyesi değildir.";

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
  L.push("", DISCLAIMER);
  return L.join("\n");
}

const HELP = [
  "🇺🇸 ABD BOT komutları",
  "/hisse SEMBOL — tek hisse teknik analizi (örn. /hisse NVDA)",
  "/sinyaller — son taramanın AL/SAT listesi",
  "/durum — bot durumu",
  "/yardim — bu liste",
].join("\n");

// ---------- Komutlar ----------
async function handleCommands(st) {
  const { updates, offset } = await fetchCommands(st.tgOffset || 0);
  st.tgOffset = offset;
  for (const { text } of updates) {
    const [cmdRaw, arg] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().split("@")[0];
    if (cmd === "/start" || cmd === "/yardim" || cmd === "/help") await sendTG(HELP);
    else if (cmd === "/hisse") {
      const sym = (arg || "").toUpperCase().replace(/[^A-Z.\-]/g, "");
      if (!sym) { await sendTG("Kullanım: /hisse SEMBOL (örn. /hisse AAPL)"); continue; }
      const live = (await liveQuotes([sym]))[sym] || null;
      const spy = await spyReturn60();
      await sendTG(fmtDetail(await analyze(sym, { live, spyRet60: spy.ret60 }).catch(() => null)));
    } else if (cmd === "/sinyaller") {
      const ls = st.lastScan;
      if (!ls) await sendTG("Henüz tarama yok.");
      else await sendTG(`📋 Son tarama (${ls.at})\n\n` + (ls.signals.map(fmtSignal).join("\n") || "Filtreyi geçen sinyal yok."));
    } else if (cmd === "/durum") {
      const ls = st.lastScan;
      await sendTG([
        "🤖 ABD BOT — durum",
        `Son tarama: ${ls ? ls.at : "yok"} · analiz edilen ${ls?.analyzed ?? 0}/${SYMS.length}`,
        `Canlı fiyat (Alpaca IEX): ${alpacaEnabled() ? "açık" : "kapalı — Yahoo kullanılıyor"}`,
        `Filtre: güven ≥ ${CFG.MIN_CONF} · ADX ≥ ${CFG.MIN_ADX} · hacim ≥ ${usd(CFG.MIN_DVOL / 1e6)}M`,
      ].join("\n"));
    }
  }
}

// ---------- Ana ----------
export async function main() {
  const t0 = Date.now();
  const st = await loadState();
  if (st === READ_FAILED) {                // durum bilinmiyor → hiçbir şey yazma, tekrar sinyal spam'i de yapma
    console.log("⚠ Gist okunamadı (geçici) — bu run atlandı, durum korunuyor.");
    return 0;
  }
  if (!gistEnabled()) console.log("ℹ Gist yapılandırılmamış — durum kalıcı değil (yerel test).");

  await handleCommands(st);

  const open = await isMarketOpen();
  if (!open && !FORCE) {
    console.log("⏰ ABD piyasası kapalı — tarama yok.");
    await saveState(st);
    return 3;
  }

  const today = nyDate();
  const [liveMap, spy] = await Promise.all([liveQuotes(SYMS), spyReturn60()]);
  const { signals, analyzed } = await scanAll(SYMS, { liveMap, spyRet60: spy.ret60 });
  console.log(`Tarama: ${analyzed}/${SYMS.length} analiz · ${signals.length} sinyal · canlı fiyat ${Object.keys(liveMap).length}`);

  // Aynı gün aynı sinyali tekrar gönderme — yalnız YENİ veya YÖN DEĞİŞTİREN sinyaller.
  if (!st.sent || st.sent.date !== today) st.sent = { date: today, map: {} };
  const fresh = signals.filter(s => st.sent.map[s.sym] !== s.signal);
  fresh.forEach(s => { st.sent.map[s.sym] = s.signal; });

  const firstOfDay = !st.lastHeaderDay || st.lastHeaderDay !== today;
  if (fresh.length || firstOfDay) {
    const al = fresh.filter(s => s.signal === "AL"), sat = fresh.filter(s => s.signal === "SAT");
    let m = `🇺🇸 ABD SPOT SİNYALLERİ${firstOfDay ? " — seans açılışı" : " — yeni"}\n${fmtTR()} (TR) · SPY 60g ${sgn(spy.ret60)}%\n`;
    if (al.length) m += `\nAL (${al.length})\n` + al.slice(0, 12).map(fmtSignal).join("\n") + "\n";
    if (sat.length) m += `\nSAT (${sat.length})\n` + sat.slice(0, 8).map(fmtSignal).join("\n") + "\n";
    if (!al.length && !sat.length) m += "\nFiltreyi geçen yeni sinyal yok.\n";
    if (analyzed === 0) m += "\n⚠ Hiçbir sembol analiz edilemedi — veri kaynağı sorunu olabilir.\n";
    m += `\n${analyzed}/${SYMS.length} hisse tarandı · ${DISCLAIMER}`;
    await sendTG(m);
    st.lastHeaderDay = today;
  } else console.log("Yeni sinyal yok — mesaj gönderilmedi.");

  st.lastScan = { at: fmtTR(), analyzed, signals: signals.slice(0, 25) };
  await saveState(st);
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
