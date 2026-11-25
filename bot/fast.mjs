// ⚡ ANİ HAREKET / ANİ DÖNÜŞ ALARMI — seans boyunca ~30 sn'de bir, en likit opsiyonlu ETF ve hisselerde 1 dk mumlarla:
//   PATLAMA : son 5 dk getirisi normal oynaklığın ≥ 3.5 katı (σ), hacim ≥ 1.8× ve son 30 dk'nın zirvesi/dibi kırıldı → hareket yönünde.
//   DÖNÜŞ   : gün içi zirve/dip son 2–15 dk içinde yapıldı, oradan ≥ 3σ ters hareket ve zirve/dip mumunun dibi/tepesi kırıldı,
//             öncesinde o yönde anlamlı bir koşu vardı → V-tepe (PUT) / V-dip (CALL).
// Bulunca 15 dk'yı BEKLEMEDEN anında Telegram: kontrat (yalnız ALIM — call ya da put), prim, stop/hedef (1:2), zaman stopu.
// Spam koruması: aynı sembol 20 dk'da en çok 1, tarama başına en güçlü 3, günde en çok 20 alarm; açılışın ilk 5 dk'sı ve
// kapanışa < 10 dk kala sessiz.
// Ölçüm (19–25 Kasım, 16 sembol, gerçek 1 dk veri, 30 dk ufuk): 15 alarm · 9 hedef · 3 stop · 3 süre doldu · ort. +1.12R.
// ⚠ Örneklem KÜÇÜK ve tek bir piyasa olayına yığılmış (19 Kasım 11:52) → kanıt değil; canlı karneyle izlenmeli.
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nyParts, isRegularHours, fmtTR } from "../data/market.mjs";
import { intradayBars, liveQuotes, alpacaEnabled, marketClock } from "../data/alpaca.mjs";
import { fetchChart, riskFreeRate } from "../data/yahoo.mjs";
import { contractIdea, nyTs, IDX } from "./idx15.mjs";
import { sendTG } from "./telegram.mjs";
import { loadFiles, saveFiles, READ_FAILED } from "./state.mjs";
import { IDEA_FILES, HORIZON, addIdea, settleIdeas } from "./ideabook.mjs";
import { macroEvents, nearEvent, fmtNear } from "./macro.mjs";
import { freshPrice, ageTxt } from "./liveaudit.mjs";
import { paperBuy, paperClose } from "./optpaper.mjs";
import { TUNE_FILE, tunedValue } from "./tune.mjs";
import { pushOpenLocal, readOpenLocal, ideaId, checkExit, optValue, fmtExit } from "./exits.mjs";

const ETFS = new Set(["SPY", "QQQ", "IWM", "DIA"]);
export const FAST = {
  SYMS: (process.env.FAST_SYMS || "SPY,QQQ,IWM,NVDA,TSLA,AAPL,MSFT,AMZN,META,GOOGL,AMD,AVGO,NFLX,PLTR,COIN,MU").split(",").map(s => s.trim()).filter(Boolean),
  POLL: 30e3, RUN_MS: 55 * 60e3, COOL_MS: 20 * 60e3, MAX_DAY: 20, PER_POLL: 3,
  Z_BURST: 3.5, Z_REV: 3, VOL_X: 1.8, MIN_BARS: 20, REV_WIN: 30,
  // Saf V-dönüş kuralı canlı veride (19–25 Kasım, 10 sembol) kaybettirdi (ort. −0.17R; z≥4'te −0.35R) → varsayılan KAPALI.
  // Dönüşler, gün zirvesi/dibinden sonraki ilk 30 dk içinde TERS yöne hacimli patlama olarak yakalanır (patlama: ort. +1.5R).
  REV_ON: process.env.FAST_REV === "1",
  MIN_MOVE: { etf: 0.003, stk: 0.008 }, MIN_R: { etf: 0.0015, stk: 0.004 },
};

const sd = xs => { const m = xs.reduce((a, x) => a + x, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

// Saf hesap (test edilebilir). bars: bugünün seans 1 dk mumları (eskiden yeniye). S: anlık fiyat (yoksa son kapanış).
// Dönüş: { kind: "burst"|"reversal", dir: "C"|"P", S, stop, target, z, move, volX, why } | null
export function detectFast(bars, S = null, etf = false) {
  const n = bars?.length || 0;
  if (n < FAST.MIN_BARS) return null;
  S = S > 0 ? S : bars[n - 1].close;
  const rets = [];
  for (let i = Math.max(1, n - 46); i < n - 5; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
  const sig = sd(rets);
  if (!(sig > 0)) return null;
  const minMove = etf ? FAST.MIN_MOVE.etf : FAST.MIN_MOVE.stk, minR = (etf ? FAST.MIN_R.etf : FAST.MIN_R.stk) * S;
  const out = (kind, dir, stop, z, move, volX, why) => {
    const R = Math.max(Math.abs(S - stop), minR), sg = dir === "C" ? 1 : -1;
    return { kind, dir, S, stop: +(S - sg * R).toFixed(2), target: +(S + sg * IDX.RR * R).toFixed(2), z: +z.toFixed(1), move, volX, why };
  };

  // 1) PATLAMA (momentum ateşlemesi)
  const p5 = bars[n - 6].close, move5 = S / p5 - 1, z5 = Math.log(S / p5) / (sig * Math.sqrt(5));
  const last5 = bars.slice(-5), prior = bars.slice(Math.max(0, n - 35), n - 5);
  const vBase = prior.reduce((a, b) => a + (b.volume || 0), 0) / Math.max(1, prior.length) * 5;
  const volX = vBase > 0 ? last5.reduce((a, b) => a + (b.volume || 0), 0) / vBase : null;
  let iHi = 0, iLo = 0;
  for (let i = 1; i < n; i++) { if (bars[i].high >= bars[iHi].high) iHi = i; if (bars[i].low <= bars[iLo].low) iLo = i; }
  const open = bars[0].open, agoHi = n - 1 - iHi, agoLo = n - 1 - iLo;
  if (Math.abs(z5) >= FAST.Z_BURST && Math.abs(move5) >= minMove && (volX == null || volX >= FAST.VOL_X)) {
    const hi = Math.max(...prior.map(b => b.high)), lo = Math.min(...prior.map(b => b.low));
    const bLo = Math.min(...last5.map(b => b.low)), bHi = Math.max(...last5.map(b => b.high));
    const base = `son 5 dk ${pctS(move5)} (normalin ${Math.abs(z5).toFixed(1)}σ katı)${volX ? ` · hacim ${volX.toFixed(1)}×` : ""}`;
    // stop: patlamanın yarısı geri alınırsa (yarı-geri çekilme) — hareketin tamamını riske etmeden.
    // Gün dibinden/zirvesinden sonraki 30 dk içinde ters yöne patlama = ANİ DÖNÜŞ (aynı kural, farklı başlık).
    if (move5 > 0 && S > hi) {
      const rev = agoLo >= 3 && agoLo <= FAST.REV_WIN && 1 - bars[iLo].low / open >= minMove;
      return out(rev ? "turn" : "burst", "C", S - (S - bLo) / 2, z5, move5, volX, rev ? `gün dibi ${bars[iLo].low.toFixed(2)} ${agoLo} dk önce → ${base} · 30 dk zirvesi kırıldı` : `${base} · 30 dk zirvesi kırıldı`);
    }
    if (move5 < 0 && S < lo) {
      const rev = agoHi >= 3 && agoHi <= FAST.REV_WIN && bars[iHi].high / open - 1 >= minMove;
      return out(rev ? "turn" : "burst", "P", S + (bHi - S) / 2, z5, move5, volX, rev ? `gün zirvesi ${bars[iHi].high.toFixed(2)} ${agoHi} dk önce → ${base} · 30 dk dibi kırıldı` : `${base} · 30 dk dibi kırıldı`);
    }
  }

  // 2) SAF V-DÖNÜŞ (varsayılan kapalı — bkz. REV_ON) — günün zirvesi/dibi son 2–15 dk'da
  if (!FAST.REV_ON) return null;
  if (agoHi >= 2 && agoHi <= 15) {
    const ext = bars[iHi].high, mv = S / ext - 1, z = Math.log(S / ext) / (sig * Math.sqrt(agoHi));
    if (z <= -FAST.Z_REV && -mv >= minMove && ext / open - 1 >= minMove && S < bars[iHi].low)
      return out("reversal", "P", ext * 1.0005, z, mv, volX, `gün zirvesi ${ext.toFixed(2)} ${agoHi} dk önce · oradan ${pctS(mv)} (${Math.abs(z).toFixed(1)}σ) · zirve mumunun dibi kırıldı`);
  }
  if (agoLo >= 2 && agoLo <= 15) {
    const ext = bars[iLo].low, mv = S / ext - 1, z = Math.log(S / ext) / (sig * Math.sqrt(agoLo));
    if (z >= FAST.Z_REV && mv >= minMove && 1 - ext / open >= minMove && S > bars[iLo].high)
      return out("reversal", "C", ext * 0.9995, z, mv, volX, `gün dibi ${ext.toFixed(2)} ${agoLo} dk önce · oradan ${pctS(mv)} (${z.toFixed(1)}σ) · dip mumunun tepesi kırıldı`);
  }
  return null;
}
const pctS = x => (x >= 0 ? "+" : "−") + "%" + Math.abs(x * 100).toFixed(2);

// Bekleme durumu (çalışma makinesinde yerel dosya; aynı iş boyunca yeniden başlatmalarda korunur)
const STATE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_fast_state.json");
const loadSt = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
const saveSt = st => { try { writeFileSync(STATE, JSON.stringify(st)); } catch {} };

// Gün içi önbellek: ilk çağrıda günün tamamı, sonra yalnız son ~4 dk çekilip birleştirilir (veri trafiği düşük kalır).
const cache = { day: null, bars: {}, last: 0 };
async function barsFor(syms, sessStart, today) {
  if (alpacaEnabled()) {
    if (cache.day !== today) { cache.day = today; cache.bars = {}; cache.last = 0; }
    const since = cache.last ? Math.max(sessStart, cache.last - 4 * 60e3) : sessStart;
    const [b, live] = await Promise.all([intradayBars(syms, new Date(since).toISOString(), "1Min").catch(() => null), liveQuotes(syms).catch(() => ({}))]);
    if (b) {
      for (const [s, arr] of Object.entries(b)) {
        const m = new Map((cache.bars[s] || []).map(x => [x.ts, x]));
        for (const x of arr) m.set(x.ts, x);                          // son (oluşmakta olan) mum güncellenir
        cache.bars[s] = [...m.values()].sort((a, c) => a.ts - c.ts);
      }
      cache.last = Date.now();
    }
    return { bars: cache.bars, live };
  }
  const bars = {};                                    // Alpaca yoksa yalnız ETF'ler (Yahoo'yu yormamak için)
  for (const s of syms.filter(x => ETFS.has(x))) bars[s] = await fetchChart(s, "1m", "1d").catch(() => []);
  return { bars, live: {} };
}

// Tek tarama: bulunan alarmları gönderir. Dönüş: gönderilen sayısı
// opts: { ev: makro olaylar, book: karne defteri (gönderilen alarm buraya eklenir) }
export async function scanFast(st, now = Date.now(), toCloseMin = null, opts = {}) {
  const { date: today, mins } = nyParts(new Date(now));
  if (st.day !== today) { st.day = today; st.cd = {}; st.n = 0; }
  if (st.n >= FAST.MAX_DAY) return 0;
  const sessStart = nyTs(today, 9, 30);
  const { bars, live } = await barsFor(FAST.SYMS, sessStart, today);
  // Önce tüm adaylar; piyasa geneli tek bir hareket aynı dakikada çok sembolü tetikler (19 Kasım 11:52'de 9 sembol) →
  // en güçlü (|z|) PER_POLL tanesi kontratla gönderilir, kalanlar aynı mesajda tek satırda anılır (bekleme süresine girerler).
  const cand = [];
  for (const sym of FAST.SYMS) {
    const b = (bars[sym] || []).filter(x => x.ts >= sessStart);
    // TAZELİK KAPISI: son 1 dk mum ≤ 3 dk önce kapanmış olmalı; canlı fiyat ≤ 2 dk değilse son mum kullanılır.
    // Bayat veriyle ASLA alarm verilmez (IEX'te işlem seyrekse ya da veri akışı durduysa).
    const barAge = b.length ? now - b.at(-1).ts - 60e3 : Infinity, lp = freshPrice(live[sym], now, 120e3);
    if (barAge > 180e3) continue;
    const sig = detectFast(b, lp, ETFS.has(sym));
    if (!sig) continue;
    sig.data = `Veri: ${lp ? `Alpaca IEX canlı · fiyat ${ageTxt(now - live[sym].ts)} önce` : alpacaEnabled() ? "son 1 dk mum" : "Yahoo 1 dk (Nasdaq gerçek zamanlı)"} · son mum ${ageTxt(Math.max(0, barAge))} önce kapandı`;
    if (now - (st.cd[sym] || 0) < FAST.COOL_MS) { console.log(`[⚡] ${sym} ${sig.dir} beklemede`); continue; }
    cand.push({ sym, sig });
  }
  if (!cand.length) return 0;
  cand.sort((a, b) => Math.abs(b.sig.z) - Math.abs(a.sig.z));
  const top = cand.slice(0, Math.min(FAST.PER_POLL, FAST.MAX_DAY - st.n)), rest = cand.slice(top.length);
  const r = await riskFreeRate().catch(() => 0.04);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(mins % 60).padStart(2, "0");
  let sent = 0;
  for (const [i, { sym, sig }] of top.entries()) {
    const allow0 = ETFS.has(sym) && (toCloseMin ?? 960 - mins) > 90;
    const c = await contractIdea({ sym, dir: sig.dir, S: sig.S, stop: sig.stop, target: sig.target, r, today, allow0, timeStop: 30 });
    const title = sig.kind === "burst" ? (sig.dir === "C" ? "⚡ ANİ YÜKSELİŞ" : "⚡ ANİ DÜŞÜŞ") : (sig.dir === "C" ? "↩️ ANİ DÖNÜŞ (dipten)" : "↩️ ANİ DÖNÜŞ (tepeden)");
    const text = [`${title} — ${sym} · ${hh}:${mm} NY · ${fmtTR(new Date(now))} TR`, sig.why,
      `${sig.dir === "C" ? "🟢 CALL AL" : "🔴 PUT AL"} (yalnız alım)`, ...c.lines, "   " + sig.data,
      ...(fmtNear(nearEvent(opts.ev, now), now) ? ["   " + fmtNear(nearEvent(opts.ev, now), now)] : []),
      ...(i === 0 && rest.length ? [`   Aynı anda: ${rest.map(x => `${x.sym} ${x.sig.dir === "C" ? "↑" : "↓"} ${pctS(x.sig.move)}`).join(" · ")} (piyasa geneli hareket)`] : []),
      "   Not: ani hareket sonrası devam da geri dönüş de olur → küçük pozisyon, stop'a uy. ⚠ Yatırım tavsiyesi değildir."].join("\n");
    if (await sendTG(text)) {
      st.cd[sym] = now; st.n++; sent++;
      const it = { src: "fast", sym, dir: sig.dir, kind: sig.kind, ts: now, S: sig.S, stop: sig.stop, target: sig.target, hor: HORIZON.fast,
        z: Math.abs(sig.z), tstop: 30, ...(c.pick ? { occ: c.pick.sym, K: c.pick.K, exp: c.expD, prem: c.pick.prem, iv: +c.pick.iv.toFixed(4) } : {}) };
      it.id = ideaId(it);
      if (it.occ) it.paper = await paperBuy(it.occ, it.prem, it.id).catch(() => null);   // sanal hesapta gerçek emir
      if (opts.book) addIdea(opts.book, it);
      pushOpenLocal([it], now);                                                          // çıkış takibi
      if (i === 0) for (const x of rest) st.cd[x.sym] = now;
      console.log(`[⚡] ${sym} ${sig.dir} gönderildi (${sig.kind}, z ${sig.z})`);
    }
  }
  return sent;
}

// ÇIKIŞ TAKİBİ: açık fikirler (15 dk + ani hareket) → STOP / HEDEF / ZAMAN / KAPANIŞ mesajı (fikir başına bir kez)
export async function monitorExits(st, book, now = Date.now(), toCloseMin = 999) {
  const done = { ...(book?.exits || {}), ...(st.exits || {}) };
  const open = readOpenLocal().filter(it => it.id && !done[it.id] && now - it.ts < 6 * 3600e3 && now > it.ts);
  if (!open.length) return 0;
  const syms = [...new Set(open.map(x => x.sym))];
  const live = alpacaEnabled() ? await liveQuotes(syms).catch(() => ({})) : {};
  let sent = 0;
  for (const it of open) {
    let bars = cache.bars[it.sym];
    if (!bars?.length && !alpacaEnabled()) bars = await fetchChart(it.sym, "1m", "1d").catch(() => []);
    const after = (bars || []).filter(b => b.ts >= it.ts);                   // yalnız fikirden SONRA başlayan mumlar
    const px = freshPrice(live[it.sym], now, 120e3) ?? after.at(-1)?.close;
    if (!px) continue;
    const ex = checkExit(it, { px, hi: after.length ? Math.max(...after.map(b => b.high)) : null, lo: after.length ? Math.min(...after.map(b => b.low)) : null, now, toCloseMin });
    if (!ex) continue;
    const closed = it.paper ? !!(await paperClose(it.occ).catch(() => null)) : false;
    const val = it.exp ? optValue(it, ex.px, now, nyTs(it.exp, 16, 0)) : null;
    if (await sendTG(fmtExit(it, ex, val, closed))) {
      (st.exits ||= {})[it.id] = now;
      if (book) (book.exits ||= {})[it.id] = now;
      sent++;
      console.log(`[çıkış] ${it.id} ${ex.why}`);
    }
  }
  for (const o of [st.exits, book?.exits]) if (o) for (const [k, t] of Object.entries(o)) if (now - t > 3 * 864e5) delete o[k];
  return sent;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Uzun yaşayan döngü: ~55 dk çalışır, sonra çıkar (iş akışı yeniden başlatır). FAST_ONCE=1 → tek tarama (test).
async function main() {
  const once = process.env.FAST_ONCE === "1", t0 = Date.now();
  const st = loadSt();
  let clk = null, clkAt = 0, book = null, bookAt = 0, ev = [], evAt = 0;
  do {
    try {
      // Karne defteri (kendi Gist dosyası): okunamazsa 10 dk sonra tekrar; ufku dolanlar 10 dk'da bir sonuçlandırılır
      if (Date.now() - bookAt > 10 * 60e3) {
        bookAt = Date.now();
        {                                                       // 10 dk'da bir: eşik dosyası (+ defter ilk kez)
          const f = await loadFiles(book ? [TUNE_FILE] : [IDEA_FILES.fast, TUNE_FILE]).catch(() => READ_FAILED);
          if (f !== READ_FAILED) { if (!book) book = f[IDEA_FILES.fast]; FAST.Z_BURST = tunedValue(f[TUNE_FILE], "fast"); }   // karneye göre σ eşiği
        }
        if (book && await settleIdeas(book, s => fetchChart(s, "1m", "5d")).catch(() => false)) await saveFiles({ [IDEA_FILES.fast]: book });
      }
      if (Date.now() - evAt > 30 * 60e3) { ev = await macroEvents().catch(() => []); evAt = Date.now(); }
      if (Date.now() - clkAt > 5 * 60e3) { clk = await marketClock().catch(() => null); clkAt = Date.now(); }
      const open = clk ? clk.open : isRegularHours();
      const { mins } = nyParts();
      const toClose = clk?.nextClose ? (clk.nextClose - Date.now()) / 60e3 : 960 - mins;
      if ((open && mins >= 575 && toClose >= 10) || process.env.FORCE === "1") {
        if (await scanFast(st, Date.now(), toClose, { ev, book }) && book) await saveFiles({ [IDEA_FILES.fast]: book });
        saveSt(st);
      }
      else if (once) console.log("[⚡] seans dışı.");
      if (open || process.env.FORCE === "1") {
        if (await monitorExits(st, book, Date.now(), toClose).catch(e => { console.error("[çıkış]", e?.message || e); return 0; }) && book) await saveFiles({ [IDEA_FILES.fast]: book });
        saveSt(st);
      }
    } catch (e) { console.error("[⚡] hata:", e?.message || e); }
    if (once) break;
    await sleep(FAST.POLL);
  } while (Date.now() - t0 < FAST.RUN_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then(() => process.exit(0));
