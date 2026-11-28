// Spot tarama — bist-bot'un scanOne mantığının ABD uyarlaması.
// Günlük mum = sinyal, haftalık mum = üst trend. Varsa Alpaca canlı fiyatı son mumu günceller.
import { getSignals, enrichData, getHigherTrend } from "../core/engine.mjs";
import { fetchDaily, weeklyFromDaily } from "../data/yahoo.mjs";
import { readFileSync, existsSync } from "node:fs";
import { nyDate, sessionFraction } from "../data/market.mjs";
import { alpacaEnabled, dailyBars } from "../data/alpaca.mjs";

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? +process.env[k] : d);
// ABD eşikleri (Kasım 2026 tam evren taraması: BIST eşikleriyle 1.328 hissenin 414'ü geçiyordu, 348'i SAT).
// Motorun güveni ABD'de yüksek kümeleniyor (AL medyanı ~89) → ayırt edici olan göreli güç, trend teyidi ve hacim.
export const CFG = {
  MIN_CONF: env("MIN_CONF", 75),          // AL güven barı
  MIN_CONF_SAT: env("MIN_CONF_SAT", 80),  // SAT güven barı
  MIN_ADX: env("MIN_ADX", 20),            // AL trend gücü
  MIN_ADX_SAT: env("MIN_ADX_SAT", 25),    // SAT trend gücü
  MAX_RSI_BUY: env("MAX_RSI_BUY", 63),    // geç/aşırı-alım girişi ele
  MIN_RSI_SAT: env("MIN_RSI_SAT", 30),    // zaten aşırı satılmışa geç SAT verme (tahliye dibi)
  MIN_DVOL: env("MIN_DVOL", 50e6),        // günlük ort. işlem hacmi ($)
  // AL = "MOMENTUM LİDERİ GERİ ÇEKİLMEDE" (research/ — 300 hisse, Haz 2023–Eki 2026, eğitim/test ayrı):
  //   12 aylık momentum (son ay hariç) evrenin en iyi %20'sinde · 52 haftalık zirvenin %5–%25 altında ·
  //   200 günlük ortalamanın üstünde · fiyat ≥ $10 · motor SAT demiyor. Günde ilk 10 (momentuma göre):
  //   21 günde evrene göre +%2.1 (eğitim) / +%3.7 (test) fazla getiri; medyan +%0.3 → avantaj büyük kazananlardan
  //   gelir (isabet ~%50). Eski motor-AL kuralı: −%0.5 / −%0.1 → kaldırıldı.
  //   Zirveden %25+ düşmüş "piyango" hisseler (ör. +%600 sonrası −%50) bilerek dışarıda: ortalamaları yüksek
  //   görünür ama hayatta kalan yanlılığı ve tek tük dev kazanan etkisi baskındır.
  MOM_TOP: env("MOM_TOP", 0.8),
  HI52_MAX: env("HI52_MAX", 0.95),
  HI52_MIN: env("HI52_MIN", 0.75),
  MIN_PRICE_AL: env("MIN_PRICE_AL", 10),
  // Hacimli sert düşüş sonrası momentum liderine girme: son 10 günde hacim ≥ 3× ort. ve günlük ≤ −%5 olan AL
  // adayları 21 günde −%0.4 / −%2.2 (isabet %32 / %36) → elenir. (Bilanço sonrası yukarı trend etkisi ise bu
  // veride tutarsızdı → kural olarak eklenmedi.)
  SHOCK_DOWN: env("SHOCK_DOWN", -0.05),
  // SAT = motorun teyitli SAT'ı + momentumu zayıf (alt %30): 21 günde −%1.3 / −%1.1 (doğru yön).
  MOM_SAT_MAX: env("MOM_SAT_MAX", 0.3),
  CONC: env("CONC", 8),
};

// Momentum eşikleri (son tam taramadan): tek sembol analizinde (/hisse, /opsiyon) sıra bunlarla yaklaşık bulunur.
let MOM_CUTS = null;
export const setMomCuts = c => { MOM_CUTS = c && isFinite(c.top) ? c : null; };

// Sıralama: AL → 12 aylık momentum (araştırmada en iyi sıralayıcı); SAT → güven + trend + göreli zayıflık.
export function quality(a) {
  if (a.signal === "AL" && a.mom12 != null) return 100 * a.mom12;
  const dir = a.signal === "SAT" ? -1 : 1;
  return a.confidence + Math.min(a.adx || 0, 40) / 2 + Math.max(0, Math.min(30, dir * (a.rs60 || 0))) / 2 + Math.min(a.volPace || 0, 2) * 5;
}

const ret = (rows, n) => {
  if (rows.length <= n) return 0;
  const a = rows[rows.length - 1 - n].close, b = rows[rows.length - 1].close;
  return a ? (b - a) / a * 100 : 0;
};

// Canlı fiyatı (aynı NY günündeyse) son günlük muma uygula.
function applyLive(daily, live) {
  if (!live || !daily.length) return daily;
  const last = daily[daily.length - 1];
  if (nyDate(new Date(last.ts)) !== nyDate(new Date(live.ts))) return daily;
  const p = live.price;
  daily[daily.length - 1] = { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) };
  return daily;
}

// Motor stop/hedefi hep ALIŞ yönüne göre verir. SAT (kısa) için fiyat etrafında aynala.
export function orientLevels(price, signal, { stopLoss, target1, target2 }) {
  if (signal !== "SAT") return { stopLoss, target1, target2 };
  const flip = v => (v == null ? v : +(2 * price - v).toFixed(2));
  return { stopLoss: flip(stopLoss), target1: flip(target1), target2: flip(target2) };
}

// Tek sembolün TAM analizi (filtresiz) — /hisse komutu ve tarama bunu kullanır.
// Bu çalışmada çekilen günlük mumlar (opsiyon tarafı HV için yeniden kullanır → tekrar istek yok)
export const dailyCache = new Map();

// Evren: spot/universe.json (S&P 500 + Nasdaq, likidite filtreli; haftalık yenilenir). Yoksa symbols.json.
export function loadUniverse() {
  const u = new URL("./universe.json", import.meta.url), f = new URL("./symbols.json", import.meta.url);
  if (existsSync(u)) { const j = JSON.parse(readFileSync(u, "utf8")); return { symbols: j.symbols, meta: j.meta || {}, updated: j.updated }; }
  return { symbols: JSON.parse(readFileSync(f, "utf8")), meta: {}, updated: null };
}

export async function analyze(sym, { live = null, spyRet60 = 0, daily: pre = null } = {}) {
  const daily = applyLive(pre && pre.length >= 60 ? pre : await fetchDaily(sym), live);
  dailyCache.set(sym, daily);
  if (daily.length < 60) return null;
  const ed = enrichData(daily);
  const last = ed[ed.length - 1];
  if (!last) return null;
  const weekly = weeklyFromDaily(daily);                    // üst trend: günlükten türetilmiş haftalık
  const k = getSignals(ed, getHigherTrend(weekly), weekly);
  if (!k) return null;
  const prev = daily.slice(-21, -1);                       // bugünün (kısmi) mumu hariç son 20 gün
  const avgVol = prev.length ? prev.reduce((a, b) => a + (b.volume || 0), 0) / prev.length : 0;
  // Hacim temposu: bugünkü hacim / (ortalama × seansın geçen kısmı). Bugünün mumu değilse frac = 1.
  const isToday = nyDate(new Date(last.ts)) === nyDate();
  const frac = isToday ? sessionFraction() : 1;
  const volPace = avgVol ? +((last.volume || 0) / (avgVol * frac)).toFixed(2) : 0;
  const ret60 = ret(daily, 60);
  const price = last.close;
  const rr = k.target1 && k.stopLoss && price > k.stopLoss ? +((k.target1 - price) / (price - k.stopLoss)).toFixed(2) : 0;
  const { stopLoss, target1, target2 } = orientLevels(price, k.final, k);
  // Faktörler: 12 aylık momentum (son ay hariç), 52 haftalık zirveye uzaklık, 200 günlük ortalamaya uzaklık
  const n = daily.length;
  const mom12 = n >= 253 && daily[n - 253].close > 0 ? daily[n - 22].close / daily[n - 253].close - 1 : null;
  // Hacimli şok (bilanço/haber vekili): son 10 günde hacim ≥ 3× 50g ortalama olan en büyük günlük hareket
  let shock = 0;
  if (n >= 70) {
    let v50 = 0; for (let j = n - 61; j < n - 11; j++) v50 += daily[j].volume || 0; v50 /= 50;
    for (let j = n - 10; j < n; j++) {
      const dr = daily[j].close / daily[j - 1].close - 1;
      if (v50 > 0 && (daily[j].volume || 0) >= 3 * v50 && Math.abs(dr) > Math.abs(shock)) shock = dr;
    }
  }
  let hi = 0; for (let j = Math.max(0, n - 252); j < n; j++) hi = Math.max(hi, daily[j].high || daily[j].close);
  let s200 = 0; if (n >= 200) { for (let j = n - 200; j < n; j++) s200 += daily[j].close; s200 /= 200; }
  const a = {
    sym, price, live: !!live, signal: k.final, engSignal: k.final, confidence: k.confidence, adx: Math.round(k.adx || 0),
    rsi: last.rsi != null ? Math.round(last.rsi) : null, htf: k.higherTrend, htfNote: k.htfNote || "",
    dip: k.dipSignal ? (k.dipSignal.score || 1) : 0, stopLoss, target1, target2,
    rr, atr: last.atr > 0 ? +last.atr.toFixed(2) : null, mod: k.mod, entryHint: k.entryHint,
    waitReasons: k.waitReasons, dollarVol: Math.round(avgVol * price), volPace,
    ret60: +ret60.toFixed(1), rs60: +(ret60 - spyRet60).toFixed(1),   // SPY'a göre göreli güç
    mom12: mom12 != null ? +mom12.toFixed(4) : null, hi52: hi ? +(price / hi).toFixed(4) : null,
    a200: s200 ? +(price / s200 - 1).toFixed(4) : null,
    shock: +shock.toFixed(4),
  };
  if (MOM_CUTS && a.mom12 != null) a.momRank = a.mom12 >= MOM_CUTS.top ? 0.9 : a.mom12 <= MOM_CUTS.low ? 0.1 : 0.5;
  classify(a);   // opsiyon motoru yalnızca filtreyi geçen sinyale yön verir
  return a;
}

// Hangi seçim? "AL" | "SAT" | null. a.momRank: 12 aylık momentumun evren içindeki yüzdelik sırası (0..1).
export function pickOf(a) {
  if (!a || !(a.dollarVol >= CFG.MIN_DVOL)) return null;
  const eng = a.engSignal ?? a.signal;
  if (a.momRank == null) return null;                                // sıra bilinmeden seçim yok
  if (eng !== "SAT" && a.momRank >= CFG.MOM_TOP && a.hi52 != null && a.hi52 < CFG.HI52_MAX && a.hi52 >= CFG.HI52_MIN &&
      !((a.shock ?? 0) <= CFG.SHOCK_DOWN) &&
      (a.a200 ?? -1) > 0 && !(a.price < CFG.MIN_PRICE_AL)) return "AL";
  if (eng === "SAT") {
    // SAT: teyitli düşüş — haftalık trend AŞAĞI, güçlü trend, SPY'dan zayıf, henüz aşırı satılmamış, momentum zayıf.
    if (a.confidence < CFG.MIN_CONF_SAT || a.htf !== "ASAGI" || a.adx < CFG.MIN_ADX_SAT) return null;
    if ((a.rs60 ?? 0) >= 0 || (a.rsi ?? 50) < CFG.MIN_RSI_SAT || a.momRank > CFG.MOM_SAT_MAX) return null;
    return "SAT";
  }
  return null;
}
export const passes = a => !!pickOf(a);

// Seçimi analize işle: signal = seçim (yoksa motorun sinyali), passed, pick. AL seçiminde seviyeler ATR'den:
// stop 2.5·ATR altı, hedef 5·ATR (R:R 2), tutma ufku ~21 işlem günü (araştırmanın ölçtüğü ufuk).
export function classify(a) {
  if (!a) return null;
  a.engSignal ??= a.signal;
  const pick = pickOf(a);
  a.pick = pick; a.passed = !!pick; a.signal = pick || a.engSignal;
  if (pick === "AL" && a.atr) {
    a.stopLoss = +(a.price - 2.5 * a.atr).toFixed(2); a.target1 = +(a.price + 5 * a.atr).toFixed(2);
    a.target2 = +(a.price + 7.5 * a.atr).toFixed(2); a.rr = 2;
  }
  return pick;
}

// Kesitsel sıra: likit hisseler içinde 12 aylık momentum yüzdeliği → seçimleri yeniden hesapla.
// Dönüş: eşikler { top: %MOM_TOP yüzdeliği, low: %MOM_SAT_MAX yüzdeliği } (tek sembol analizi için saklanır).
export function rankAndClassify(list) {
  const liq = list.filter(a => a && a.mom12 != null && a.dollarVol >= CFG.MIN_DVOL).sort((a, b) => a.mom12 - b.mom12);
  liq.forEach((a, i) => { a.momRank = liq.length > 1 ? i / (liq.length - 1) : 0.5; });
  list.forEach(a => a && classify(a));
  if (liq.length < 20) return null;
  const at = p => liq[Math.min(liq.length - 1, Math.round(p * (liq.length - 1)))].mom12;
  return { top: at(CFG.MOM_TOP), low: at(CFG.MOM_SAT_MAX), n: liq.length };
}

export async function scanAll(symbols, { liveMap = {}, spyRet60 = 0 } = {}) {
  const out = [], all = [];
  let ok = 0;
  // Alpaca varsa tüm mumlar toplu çekilir (~60 istek); yoksa/eksikse sembol başına Yahoo.
  const bulk = alpacaEnabled() ? await dailyBars(symbols) : {};
  const nBulk = Object.keys(bulk).length;
  if (alpacaEnabled()) console.log(`Alpaca toplu mum: ${nBulk}/${symbols.length} sembol`);
  const conc = nBulk ? 32 : CFG.CONC;                       // toplu veride iş CPU'da → yüksek eşzamanlılık
  for (let i = 0; i < symbols.length; i += conc) {
    const batch = symbols.slice(i, i + conc);
    const res = await Promise.all(batch.map(s => analyze(s, { live: liveMap[s], spyRet60, daily: bulk[s] }).catch(() => null)));
    res.forEach(a => { if (a) { ok++; all.push(a); } });
  }
  // Momentum sırası tüm evren üzerinden (taranan küme çekirdekse eski eşikler korunur)
  const cuts = symbols.length >= 200 ? rankAndClassify(all) : (all.forEach(a => classify(a)), null);
  if (cuts) setMomCuts(cuts);
  for (const a of all) if (a.passed) out.push(a);
  out.forEach(a => { a.q = +quality(a).toFixed(1); });
  out.sort((a, b) => a.signal !== b.signal ? (a.signal === "AL" ? -1 : 1) : b.q - a.q);
  return { signals: out, analyzed: ok, all, cuts };
}

export async function spyReturn60() {
  const d = await fetchDaily("SPY");
  dailyCache.set("SPY", d);
  return { ret60: +ret(d, 60).toFixed(1), rows: d };
}
