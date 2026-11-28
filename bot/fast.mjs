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
import { fetchChart, fetchDaily, riskFreeRate } from "../data/yahoo.mjs";
import { contractIdea, nyTs, IDX, capStop, setSizing } from "./idx15.mjs";
import { PREFS_FILE, isOn } from "./prefs.mjs";
import { closeTsOf } from "../data/market.mjs";
import { sendTG } from "./telegram.mjs";
import { loadFiles, saveFiles, READ_FAILED } from "./state.mjs";
import { IDEA_FILES, HORIZON, addIdea, settleIdeas, fmtIdeaReport } from "./ideabook.mjs";
import { panelEnabled, PANEL, readFeed, seedFeed, loadPanel, buildSnapshot, publishPanel, readTaKarne, readTaRecent, recentIdeas } from "./panel.mjs";
import { macroEvents, nearEvent, fmtNear } from "./macro.mjs";
import { freshPrice, ageTxt } from "./liveaudit.mjs";
import { paperBuy, paperClose, warnPaperFail, paperQty } from "./optpaper.mjs";
import { GUARD, guardDecision, clusterMembers, corrRet, computeLead, pausedList, keyLabel } from "./guard.mjs";
import { TUNE_FILE, tunedValue } from "./tune.mjs";
import { dayFeatures, setupsAt, breadthSeries, dayType, features } from "./setups.mjs";
import { SETUPS_FILE, allowedFor, SETUP_LABEL, MEMBERS, modelCheck, INTERNALS_FILE, readInternals } from "./setuplive.mjs";
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

// KORUYUCU (bot/guard.mjs): canlı karnede kaybettiren tür durur · adet karneye göre · aynı yöne yığılma sınırı (lider sektöre esnek)
function activeIdeas(st, book, now) {
  const done = { ...(book?.exits || {}), ...(st.exits || {}) };
  return readOpenLocal().filter(o => o.id && !done[o.id] && o.ts <= now && now - o.ts < GUARD.OPEN_MIN * 60e3);
}
// Sektör liderliği (11 SPDR vs SPY, bugünkü 5 dk mumlar): kurulum taraması zaten hesaplar; yoksa yalnız gerektiğinde çekilir
async function ensureLead(st, now) {
  if (st.lead && now - st.lead.ts < 10 * 60e3) return st.lead;
  const { date: today } = nyParts(new Date(now)), sessStart = nyTs(today, 9, 30), syms = ["SPY", ...SET_SECS];
  const bars = alpacaEnabled()
    ? await intradayBars(syms, new Date(sessStart).toISOString(), "5Min").catch(() => null)
    : Object.fromEntries(await Promise.all(syms.map(async s => [s, (await fetchChart(s, "5m", "1d").catch(() => [])).filter(b => b.ts >= sessStart)])));
  const lead = bars ? computeLead(bars, now) : null;
  if (lead) st.lead = lead;
  return st.lead && now - st.lead.ts < 30 * 60e3 ? st.lead : null;
}
async function guardIdea(st, book, it, now) {
  const open = activeIdeas(st, book, now), corrOf = (a, b) => corrRet(cache.bars[a], cache.bars[b]);
  const lead = await ensureLead(st, now).catch(() => null);                // kesişim karnesi için her fikirde (10 dk önbellek)
  const g = guardDecision(it, { ideas: book?.ideas, open, lead, corrOf, now });
  console.log(`[koruma] ${it.sym} ${it.dir} ${g.ok ? `×${g.mult}${g.tag ? " · " + g.tag : ""}` : "gönderilmedi — " + g.why}`);
  return g;
}
const paperQtyM = (prem, mult) => { const q = paperQty(prem); return q && mult !== 1 ? Math.max(1, Math.floor(q * mult)) : null; };
// Yeni durdurulan tür → tek seferlik kısa bildirim (defterde tutulur; süreç yeniden başlasa da tekrar atılmaz)
async function pauseNotices(book, prefs, now) {
  const pl = pausedList(book.ideas, now), note = (book.pauseNote ||= {});
  let ch = false;
  for (const p of pl) {
    if (note[p.key] || !isOn(prefs, p.key.startsWith("setup") ? "kurulum" : "ani")) continue;
    if (await sendTG(`⏸ ${keyLabel(p.key)} durduruldu — canlıda son 10 fikir toplam ${p.s10}R. ${p.daysLeft} gün sonra ×${GUARD.TRIAL} adetle yeniden denenir.`, { panel: "karne" })) { note[p.key] = now; ch = true; }
  }
  for (const k of Object.keys(note)) if (!pl.some(p => p.key === k)) { delete note[k]; ch = true; }
  return ch;
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
    // A/B: 0DTE'ye izin varken fikirler sırayla 0DTE / sonraki vade → sanal hesapta hangisi daha iyi, ölçülür
    const allow0 = ETFS.has(sym) && (toCloseMin ?? 960 - mins) > 90 && (st.ab = !st.ab);
    const closeMs = now + (toCloseMin ?? 960 - mins) * 60e3;                 // gerçek kapanış (erken kapanış dahil)
    const g = await guardIdea(st, opts.book, { src: "fast", kind: sig.kind, dir: sig.dir, sym }, now);
    if (!g.ok) { st.cd[sym] = now; continue; }
    const c = await contractIdea({ sym, dir: sig.dir, S: sig.S, stop: sig.stop, target: sig.target, r, today, allow0, timeStop: capStop(30, closeMs, now), mult: g.mult, multTag: g.tag });
    const title = sig.kind === "burst" ? (sig.dir === "C" ? "⚡ Ani yükseliş" : "⚡ Ani düşüş") : (sig.dir === "C" ? "↩️ Dipten dönüş" : "↩️ Tepeden dönüş");
    console.log(`[⚡] ${sym} ${sig.kind} ${sig.dir} · ${sig.why} · ${sig.data}`);
    const near = fmtNear(nearEvent(opts.ev, now), now);
    const text = [`${title} · ${sig.dir === "C" ? "🟢" : "🔴"} ${sym} ${sig.dir === "C" ? "CALL" : "PUT"} AL — ${c.contract}`, ...c.lines,
      ...(near ? ["   " + near] : []),
      ...(i === 0 && rest.length ? [`   Aynı anda: ${rest.map(x => `${x.sym} ${x.sig.dir === "C" ? "↑" : "↓"}`).join(" ")}`] : [])].join("\n");
    if (await sendTG(text, { panel: "fikir" })) {
      st.cd[sym] = now; st.n++; sent++;
      const it = { src: "fast", sym, dir: sig.dir, kind: sig.kind, ts: now, S: sig.S, stop: sig.stop, target: sig.target, hor: HORIZON.fast,
        z: Math.abs(sig.z), mult: g.mult, lead: g.leader ?? null, tstop: c.timeStop, expClose: c.expClose, ...(c.pick ? { occ: c.pick.sym, K: c.pick.K, exp: c.expD, prem: c.pick.prem, iv: +c.pick.iv.toFixed(4) } : {}) };
      it.id = ideaId(it);
      if (it.occ) {
        it.paper = await paperBuy(it.occ, it.prem, it.id, paperQtyM(it.prem, g.mult)).catch(() => null);   // sanal hesapta gerçek emir
        if (!it.paper) await warnPaperFail(sendTG, it.occ).catch(() => {});
      }
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
    if (!bars?.length) bars = alpacaEnabled()                                              // ani hareket taraması kapalıysa önbellek boş → kendisi çeker
      ? ((await intradayBars([it.sym], new Date(it.ts - 60e3).toISOString(), "1Min").catch(() => null)) || {})[it.sym] || []
      : await fetchChart(it.sym, "1m", "1d").catch(() => []);
    const after = (bars || []).filter(b => b.ts >= it.ts);                   // yalnız fikirden SONRA başlayan mumlar
    const px = freshPrice(live[it.sym], now, 120e3) ?? after.at(-1)?.close;
    if (!px) continue;
    const ex = checkExit(it, { px, hi: after.length ? Math.max(...after.map(b => b.high)) : null, lo: after.length ? Math.min(...after.map(b => b.low)) : null, now, toCloseMin });
    if (!ex) continue;
    const closed = it.paper ? !!(await paperClose(it.occ).catch(() => null)) : false;
    const val = it.exp ? optValue(it, ex.px, now, it.expClose ?? await closeTsOf(it.exp)) : null;   // GERÇEK vade kapanışıyla
    if (await sendTG(fmtExit(it, ex, val, closed), { panel: "cikis" })) {
      (st.exits ||= {})[it.id] = now;
      if (book) (book.exits ||= {})[it.id] = now;
      sent++;
      console.log(`[çıkış] ${it.id} ${ex.why}`);
    }
  }
  for (const o of [st.exits, book?.exits]) if (o) for (const [k, t] of Object.entries(o)) if (now - t > 3 * 864e5) delete o[k];
  return sent;
}

// ÖLÇÜLMÜŞ GÜN İÇİ KURULUMLAR (bot/setups.mjs): her yeni 5 dk mum kapanışında SPY/QQQ taranır (sektör genişliğiyle);
// yalnız 1 yıllık ölçümü geçen kurulum × yön × gün parçası gönderilir (abd_setups.json). Diğerleri yalnız loga yazılır.
const SET_SYMS = ["SPY", "QQQ"], SET_SECS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
export async function scanSetups(st, now, toCloseMin, opts = {}) {
  const { date: today } = nyParts(new Date(now)), sessStart = nyTs(today, 9, 30);
  const k = Math.floor((now - sessStart) / 300e3);                          // tamamlanmış 5 dk mum sayısı
  if (k < 7) return 0;
  const key = `${today}|${k}`;
  if (st.setKey === key) return 0;                                            // her mum kapanışında bir kez
  let bars;
  if (alpacaEnabled()) bars = await intradayBars([...SET_SYMS, ...SET_SECS, ...MEMBERS], new Date(sessStart).toISOString(), "5Min").catch(() => null);
  else bars = Object.fromEntries(await Promise.all(SET_SYMS.map(async s => [s, await fetchChart(s, "5m", "1d").catch(() => [])])));
  if (!bars) return 0;
  st.setKey = key;
  const done = arr => (arr || []).filter(b => b.ts >= sessStart && b.ts + 300e3 <= now);
  const sec = Object.fromEntries(SET_SECS.map(s => [s, done(bars[s])]).filter(([, a]) => a.length >= 8));
  const mem = Object.fromEntries(MEMBERS.map(s => [s, done(bars[s])]).filter(([, a]) => a.length >= 3));
  { const ld = computeLead({ SPY: done(bars.SPY), ...sec }, now); if (ld) st.lead = ld; }          // koruyucu için sektör liderliği
  // Dünkü seviyeler + günlük ATR (günde 1 kez)
  if (st.lvDay !== today) {
    st.lv = {};
    for (const sym of SET_SYMS) {
      const d = (await fetchDaily(sym).catch(() => [])).filter(r => nyParts(new Date(r.ts)).date < today);
      if (d.length > 15) { const y = d.at(-1), rg = d.slice(-14).map(r => r.high - r.low); st.lv[sym] = { pdh: y.high, pdl: y.low, pdc: y.close, dATR: rg.reduce((a, b) => a + b, 0) / rg.length }; }
    }
    st.lvDay = today;
  }
  let sent = 0;
  for (const sym of SET_SYMS) {
    const bs = done(bars[sym]);
    if (bs.length < 8 || bs.at(-1).ts < sessStart + (k - 1) * 300e3) continue;          // son mum eksik → bayat, karar yok
    const f = dayFeatures(bs), i = bs.length - 1, mins = nyParts(new Date(bs[i].ts)).mins + 5;
    const ts = bs.map(b => b.ts), lv = st.lv?.[sym] || {};
    const br = Object.keys(sec).length >= 8 ? breadthSeries(ts, sec) : null, mb = Object.keys(mem).length >= 25 ? breadthSeries(ts, mem) : null;
    const dt = dayType(bs, i, lv.dATR);
    if (sym === "SPY") writeInternals({ ts: now, mb: mb?.at(-1) ?? null, br: br?.at(-1) ?? null, dt, up: upCount(mem, ts.at(-1)) });
    for (const c of setupsAt(bs, f, i, mins, br, { pdh: lv.pdh, pdl: lv.pdl, pdc: lv.pdc, mb })) {
      const a = allowedFor(opts.allow, c.name, c.dir, mins, dt);
      if (!a) { console.log(`[kurulum] ${sym} ${c.name} ${c.dir} (${dt}) oluştu — ölçümde geçmedi, gönderilmedi`); continue; }
      const mc = modelCheck(opts.model, features(bs, f, i, mins, c, { br, mb, pdc: lv.pdc, dATR: lv.dATR, dt }));
      if (!mc.ok) { console.log(`[kurulum] ${sym} ${c.name} ${c.dir} model olasılığı %${Math.round(mc.p * 100)} < eşik → gönderilmedi`); continue; }
      const ck = `${sym}|${c.name}|${c.dir}`;
      if (now - ((st.setCd ||= {})[ck] || 0) < 30 * 60e3) continue;
      const g = await guardIdea(st, opts.book, { src: "setup", setup: c.name, sym, dir: c.dir }, now);
      if (!g.ok) { st.setCd[ck] = now; continue; }
      const S = freshPrice((await liveQuotes([sym]).catch(() => ({})))[sym], now, 120e3) ?? bs[i].close;
      const R = Math.abs(S - c.stop);
      if ((c.dir === "C" ? S <= c.stop : S >= c.stop) || !(R > 0)) continue;         // fiyat stopu çoktan geçtiyse fikir yok
      const target = +(c.dir === "C" ? S + 2 * R : S - 2 * R).toFixed(2), stop = +c.stop.toFixed(2);
      const closeMs = now + (toCloseMin ?? 960 - mins) * 60e3, r = await riskFreeRate().catch(() => 0.04);
      const cc = await contractIdea({ sym, dir: c.dir, S, stop, target, r, today, allow0: (closeMs - now) / 60e3 > 90 && (st.ab = !st.ab), timeStop: capStop(a.hor, closeMs, now), mult: g.mult, multTag: g.tag });
      const near = fmtNear(nearEvent(opts.ev, now), now);
      const text = [`🎯 ${sym} ${c.dir === "C" ? "CALL" : "PUT"} AL — ${cc.contract}`, `   ${SETUP_LABEL[c.name][c.dir]}`, ...cc.lines, ...(near ? ["   " + near] : [])].join("\n");
      if (!(await sendTG(text, { panel: "fikir" }))) continue;
      st.setCd[ck] = now; sent++;
      const it = { src: "setup", setup: c.name, sym, dir: c.dir, ts: now, S, stop, target, hor: a.hor, mult: g.mult, lead: g.leader ?? null, tstop: cc.timeStop, expClose: cc.expClose,
        ...(cc.pick ? { occ: cc.pick.sym, K: cc.pick.K, exp: cc.expD, prem: cc.pick.prem, iv: +cc.pick.iv.toFixed(4) } : {}) };
      it.id = ideaId(it);
      if (it.occ) { it.paper = await paperBuy(it.occ, it.prem, it.id, paperQtyM(it.prem, g.mult)).catch(() => null); if (!it.paper) await warnPaperFail(sendTG, it.occ).catch(() => {}); }
      if (opts.book) addIdea(opts.book, it);
      pushOpenLocal([it], now);
      console.log(`[kurulum] ${sym} ${c.name} ${c.dir} GÖNDERİLDİ`);
    }
  }
  return sent;
}

// Piyasa içi özet (15 dk mesajı okur): aynı makinede yerel dosya
function writeInternals(o) { try { writeFileSync(INTERNALS_FILE, JSON.stringify(o)); } catch {} }
// Son 5 dk mumunu yükselişle kapatan büyük hisse sayısı / toplam
function upCount(mem, ts) {
  let u = 0, n = 0;
  for (const arr of Object.values(mem)) { const b = arr.find(x => x.ts === ts); if (b) { n++; if (b.close > b.open) u++; } }
  return n ? { u, n } : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// WEB PANELİ yayını (bot/panel.mjs): seans içinde 2 dk, dışında 15 dk'da bir. Yeni makinede yerel kayıt boşsa yayındaki panelden doldurulur.
let pubAt = 0, seeded = false;
async function panelStep(st, book, open) {
  if (!panelEnabled() || Date.now() - pubAt < (open ? PANEL.PUB_MS : PANEL.PUB_IDLE_MS)) return;
  pubAt = Date.now();
  if (!seeded) {
    seeded = true;
    const prev = await loadPanel(), local = readFeed(), seen = new Set(local.map(x => x.ts + "|" + x.cat));
    const add = (prev?.feed || []).filter(x => x?.ts && !seen.has(x.ts + "|" + x.cat));
    if (add.length) seedFeed([...add, ...local].sort((a, b) => a.ts - b.ts));
  }
  const now = Date.now(), done = { ...(book?.exits || {}), ...(st.exits || {}) };
  const openIdeas = readOpenLocal().filter(o => o.id && !done[o.id] && o.ts <= now && now - o.ts < 6 * 3600e3);
  await publishPanel(buildSnapshot({ feed: readFeed(), internals: readInternals(now, 30 * 60e3), lead: st.lead,
    karne: [book ? fmtIdeaReport({ fast: book }, now) : null, readTaKarne()].filter(Boolean).join("\n\n") || null, paused: book ? pausedList(book.ideas, now) : [], open: openIdeas, recent: recentIdeas(book?.ideas, readTaRecent(), now), now }));
}
// Uzun yaşayan döngü: ~55 dk çalışır, sonra çıkar (iş akışı yeniden başlatır). FAST_ONCE=1 → tek tarama (test).
async function main() {
  const once = process.env.FAST_ONCE === "1", t0 = Date.now();
  const st = loadSt();
  let clk = null, clkAt = 0, book = null, bookAt = 0, ev = [], evAt = 0, allow = [], model = null, prefs = null;
  do {
    try {
      // Karne defteri (kendi Gist dosyası): okunamazsa 10 dk sonra tekrar; ufku dolanlar 10 dk'da bir sonuçlandırılır
      if (Date.now() - bookAt > 10 * 60e3) {
        bookAt = Date.now();
        {                                                       // 10 dk'da bir: eşik dosyası (+ defter ilk kez)
          const f = await loadFiles(book ? [TUNE_FILE, SETUPS_FILE, PREFS_FILE] : [IDEA_FILES.fast, TUNE_FILE, SETUPS_FILE, PREFS_FILE]).catch(() => READ_FAILED);
          if (f !== READ_FAILED) {
            if (!book) book = f[IDEA_FILES.fast];
            FAST.Z_BURST = tunedValue(f[TUNE_FILE], "fast");                       // karneye göre σ eşiği
            allow = f[SETUPS_FILE]?.allow || [];                                    // ölçümü geçen kurulumlar
            model = f[SETUPS_FILE]?.model || null;                                  // olasılık modeli (yalnız testte işe yaradıysa "use")
            prefs = f[PREFS_FILE] || null; setSizing(prefs);                         // /ayarlar + /hesap
          }
        }
        if (book && await settleIdeas(book, s => fetchChart(s, "1m", "5d")).catch(() => false)) await saveFiles({ [IDEA_FILES.fast]: book });
        if (book && await pauseNotices(book, prefs, Date.now()).catch(() => false)) await saveFiles({ [IDEA_FILES.fast]: book });
      }
      if (Date.now() - evAt > 30 * 60e3) { ev = await macroEvents().catch(() => []); evAt = Date.now(); }
      if (Date.now() - clkAt > 5 * 60e3) { clk = await marketClock().catch(() => null); clkAt = Date.now(); }
      const open = clk ? clk.open : isRegularHours();
      const { mins } = nyParts();
      const toClose = clk?.nextClose ? (clk.nextClose - Date.now()) / 60e3 : 960 - mins;
      if ((open && mins >= 575 && toClose >= 10) || process.env.FORCE === "1") {
        if (isOn(prefs, "ani") && await scanFast(st, Date.now(), toClose, { ev, book }) && book) await saveFiles({ [IDEA_FILES.fast]: book });
        if (isOn(prefs, "kurulum") && await scanSetups(st, Date.now(), toClose, { ev, book, allow, model }).catch(e => { console.error("[kurulum]", e?.message || e); return 0; }) && book) await saveFiles({ [IDEA_FILES.fast]: book });
        saveSt(st);
      }
      else if (once) console.log("[⚡] seans dışı.");
      await panelStep(st, book, open).catch(e => console.error("[panel]", e?.message || e));
      if ((open || process.env.FORCE === "1") && isOn(prefs, "cikis")) {
        if (await monitorExits(st, book, Date.now(), toClose).catch(e => { console.error("[çıkış]", e?.message || e); return 0; }) && book) await saveFiles({ [IDEA_FILES.fast]: book });
        saveSt(st);
      }
    } catch (e) { console.error("[⚡] hata:", e?.message || e); }
    if (once) break;
    await sleep(FAST.POLL);
  } while (Date.now() - t0 < FAST.RUN_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then(() => process.exit(0));
