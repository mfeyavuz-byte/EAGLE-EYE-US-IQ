// OPSİYON KARAR MOTORU
// 1) Yön: spot motorunun sinyali (AL/SAT/NÖTR) ve güveni → yön puanı (−1..+1)
// 2) Oynaklık rejimi: IV rank (geçmiş varsa) / IV÷HV (oynaklık risk primi) → ucuz | adil | zengin
// 3) Olay: bilanço vade içinde mi? Vade yapısı ters mi?
// 4) Yön × rejim matrisi → izin verilen stratejiler
// 5) Her aday: gerçekçi dolum, maks kâr/zarar, başabaş, piyasa POP'u, BİZİM POP'umuz ve beklenen değer
//    (kalın kuyruklu dağılım + gerçekleşen oynaklık + küçük sinyal eğimi), CVaR %5, Greek'ler
// 6) Eleme: EV ≤ 0, avantaj < MIN_EDGE, likidite, kâr olasılığı tabanı → sıralama → en iyi fikirler (çeşitli)
import { loadChain } from "./chain.mjs";
import { volDashboard, atmIV } from "./vol.mjs";
import { candidates, STRAT } from "./strategies.mjs";
import { terminalDist, evaluate, skewK } from "./dist.mjs";

export const OCFG = {
  MIN_EDGE: +(process.env.OPT_MIN_EDGE || 0.03),     // EV / maks zarar ≥ %3
  ACCOUNT: +(process.env.OPT_ACCOUNT || 10000),      // boyutlandırma için hesap büyüklüğü ($)
  RISK: +(process.env.OPT_RISK || 0.02),             // işlem başına hesabın en çok %2'si riske
  // En güçlü sinyalde bile en fazla 0.15σ yön eğimi. Spot sinyalinin ABD isabeti backtest'le doğrulanınca artırılabilir.
  TILT: +(process.env.OPT_TILT || 0.15),
  // Vade yapısı (yakın IV / IV30). > INV → ters: oynaklık avantajı iddia edilmez (σ ≥ IV).
  // > INV_HARD → belirgin stres: iron condor (yönsüz prim satışı) yasak — büyük hareketler tam bu dönemlerde gelir.
  INV: +(process.env.OPT_INV || 1.1),
  INV_HARD: +(process.env.OPT_INV_HARD || 1.25),
  // Yön tahmininin EV katkısına güven payı. Spot sinyalinin ABD isabeti /karne ve backtest'le doğrulanana dek
  // yön kaynaklı EV yarı ağırlıkla sayılır → avantajı YALNIZCA yön tahminine dayanan fikir zor geçer.
  DIR_TRUST: +(process.env.OPT_DIR_TRUST || 0.5),
};

// Spot analizinden yön puanı. Güven 50 → 0, 100 → ±1.
export function directionOf(a) {
  if (!a || a.signal === "NÖTR") return { dir: 0, score: 0, label: "NÖTR" };
  // Spot kalite filtresini geçmeyen sinyal (zayıf trend, SPY'a göre ters göreli güç vb.) yön sayılmaz.
  if (a.passed === false) return { dir: 0, score: 0, label: `NÖTR (${a.signal} %${a.confidence} filtreden geçmedi)` };
  const s = Math.max(0, Math.min(1, ((a.confidence || 50) - 50) / 50));
  if (s < 0.2) return { dir: 0, score: 0, label: "NÖTR (zayıf sinyal)" };
  return a.signal === "AL" ? { dir: 1, score: s, label: `YUKARI (AL %${a.confidence})` } : { dir: -1, score: -s, label: `AŞAĞI (SAT %${a.confidence})` };
}

// Yön × rejim matrisi (+ stres freni: vade yapısı belirgin tersse yönsüz prim satışı yok)
export function allowedFor(dir, regime, ivhv, termRatio = null) {
  if (dir > 0) return new Set(regime === "ucuz" ? ["LONG_CALL", "BULL_CALL"] : regime === "zengin" ? ["BULL_PUT", "BULL_CALL"] : ["BULL_CALL", "BULL_PUT"]);
  if (dir < 0) return new Set(regime === "ucuz" ? ["LONG_PUT", "BEAR_PUT"] : regime === "zengin" ? ["BEAR_CALL", "BEAR_PUT"] : ["BEAR_PUT", "BEAR_CALL"]);
  if (termRatio && termRatio > OCFG.INV_HARD) return new Set();
  if (regime === "zengin" || (regime === "adil" && (ivhv ?? 0) >= 1.1)) return new Set(["IRON_CONDOR"]);
  return new Set();
}

// Ana analiz. spot: spot/scan.mjs analyze() çıktısı; daily: günlük mumlar; hist: IV30 geçmişi.
export async function analyzeOptions(sym, { spot, daily, r, hist = null, top = 3 }) {
  const chain = await loadChain(sym, r);
  if (!chain || !chain.expiries.length) return { sym, error: "Opsiyon zinciri alınamadı (opsiyonu olmayan/illikit hisse olabilir)." };
  const vol = volDashboard(chain, daily, hist);
  const d = directionOf(spot);
  const allowed = allowedFor(d.dir, vol.regime, vol.ivhv, vol.termRatio);
  const stress = vol.termRatio && vol.termRatio > OCFG.INV_HARD;
  const reasons = [`Yön: ${d.label}`, `Oynaklık: ${vol.regime}${vol.rank != null ? ` (IV rank ${vol.rank})` : vol.ivhv ? ` (IV/HV ${vol.ivhv.toFixed(2)})` : ""}`];
  if (vol.termRatio && vol.termRatio > OCFG.INV) reasons.push(`Vade yapısı TERS (${vol.termRatio.toFixed(2)}) — yakın vadede olay/stres fiyatlanıyor${stress ? "; yönsüz prim satışı (iron condor) yasak" : ""}`);
  if (Math.abs(chain.parityGap) >= 0.002) reasons.push(`Dayanak fiyatı zincirden (parite) alındı: $${chain.S.toFixed(2)} (kotasyon $${chain.Squote.toFixed(2)}, fark ${(chain.parityGap * 100).toFixed(2)}%)`);
  const base = { sym, S: chain.S, vol, dir: d, reasons, allowed: [...allowed] };
  if (chain.S < 10) return { ...base, ideas: [], note: "Fiyat < $10 — opsiyon spread'leri genelde verimsiz." };
  if (!allowed.size) return { ...base, ideas: [], note: d.dir === 0
    ? (stress && (vol.regime === "zengin" || (vol.ivhv ?? 0) >= 1.1)
      ? "Oynaklık pahalı ama vade yapısı belirgin ters (stres) → yönsüz prim satışı yapılmaz (BEKLE)."
      : "Yön yok ve oynaklık pahalı değil → avantajlı opsiyon yapısı yok (BEKLE).")
    : "Uygun yapı yok." };

  const now = Date.now();
  const ideas = [];
  for (const ex of chain.expiries) {
    if (ex.dte < 14 || ex.dte > 75) continue;                           // işlem penceresi
    const expMs = ex.exp * 1e3 + 20 * 3600e3;
    const earnInside = chain.earningsTs && chain.earningsTs * 1e3 > now && chain.earningsTs * 1e3 < expMs;
    let allow = new Set(allowed);
    if (earnInside) ["BULL_PUT", "BEAR_CALL", "IRON_CONDOR"].forEach(k => allow.delete(k));   // bilanço boşluğuna prim SATMA
    if (!allow.size) continue;

    const ivEx = atmIV(ex, chain.S, chain.r, chain.q);
    if (!ivEx) continue;
    // Fiziksel oynaklık: piyasa IV'si en iyi tek tahmincidir → %60 ağırlık (tarihsel risk primi düşülmüş ~%90'ı),
    // %40 gerçekleşen oynaklık tahmini. Muhafazakâr kurallar:
    //  • bilanço vade içinde → oynaklık avantajı İDDİA EDİLMEZ: σ ≥ IV
    //  • vade yapısı ters (piyasa stres fiyatlıyor) → σ ≥ IV (gerçekleşen oynaklık geride kalır, risk primi iddia edilmez)
    let sigP = vol.hvF ? 0.6 * 0.9 * ivEx + 0.4 * vol.hvF : 0.9 * ivEx;
    if (earnInside || (vol.termRatio && vol.termRatio > OCFG.INV)) sigP = Math.max(sigP, ivEx);
    // Kayma: taban = piyasanın ileri fiyatı (r − q) → yönsüz senaryoda ne boğa ne ayı yapılarına sistematik avantaj.
    // Üstüne sinyal eğimi: toplam = score·TILT·σ√T.
    const mu0 = chain.r - chain.q;
    const mu = mu0 + d.score * OCFG.TILT * sigP / Math.sqrt(ex.T);
    // Çarpıklık: piyasa dağılımı skew'un TAMAMINI, bizim dağılımımız %70'ini taşır
    // (put skew'unun bir kısmı tarihsel olarak risk primidir; tamamını yok saymak kuyruk riskini gizler).
    const kMkt = skewK(vol.skew, vol.iv30 || ivEx, 1), kPhys = skewK(vol.skew, vol.iv30 || ivEx, 0.7);
    const phys = terminalDist(chain.S, ex.T, sigP, mu, "t", 801, kPhys);
    const flat = d.score ? terminalDist(chain.S, ex.T, sigP, mu0, "t", 801, kPhys) : phys;   // yön eğimi olmadan (EV ayrıştırması)
    const mkt = terminalDist(chain.S, ex.T, ivEx, chain.r - chain.q, "lognormal", 801, kMkt);

    for (const c of candidates(ex, chain.S, allow)) {
      if (!isFinite(c.maxLoss) || c.maxLoss <= 0) continue;
      const e = evaluate(c.L, c.debit, phys);
      if (e.ev <= 0 || e.ev / c.maxLoss < OCFG.MIN_EDGE) continue;
      if (e.pop < (c.kind === "credit" ? 0.55 : 0.3)) continue;
      const evVol = flat === phys ? e.ev : evaluate(c.L, c.debit, flat).ev;   // oynaklık (+ maliyet) kaynaklı kısım
      const evAdj = evVol + OCFG.DIR_TRUST * (e.ev - evVol);                  // yön payı güven oranıyla
      const edge = evAdj / c.maxLoss;
      if (evAdj <= 0 || edge < OCFG.MIN_EDGE) continue;
      const m = evaluate(c.L, c.debit, mkt);
      const score = edge - 0.3 * c.spreadAvg + 0.05 * (e.pop - 0.5) - 0.0015 * Math.abs(ex.dte - 38) + (c.oiMin >= 1000 ? 0.01 : 0);
      ideas.push({ ...c, exp: ex.exp, dte: ex.dte, expDate: new Date(ex.exp * 1e3).toISOString().slice(0, 10), ivEx, sigP, earnInside, ev: e.ev, evVol, evDir: e.ev - evVol, evAdj, pop: e.pop, cvar5: e.cvar5, popMkt: m.pop, edge: e.ev / c.maxLoss, edgeAdj: edge, score });
    }
  }
  ideas.sort((a, b) => b.score - a.score);
  // Çeşitlilik: önce farklı stratejiler, sonra aynı stratejinin farklı vadeleri, en son kalanlar
  const picked = [], key = (i, k) => k === 0 ? i.code : `${i.code}|${i.exp ?? i.ex?.exp}`;
  for (const level of [0, 1, 2]) {
    const seen = new Set(picked.map(i => key(i, level)));
    for (const i of ideas) {
      if (picked.length >= top) break;
      if (picked.includes(i) || (level < 2 && seen.has(key(i, level)))) continue;
      picked.push(i); seen.add(key(i, level));
    }
  }
  picked.forEach(i => {
    i.contracts = Math.floor(OCFG.ACCOUNT * OCFG.RISK / i.maxLoss);
    i.minAccount = Math.ceil(i.maxLoss / OCFG.RISK / 1000) * 1000;   // %2 kuralıyla 1 kontrat için gereken hesap
    i.rules = rulesFor(i);
    i.manage = manageRules(i);
  });
  return { ...base, ideas: picked, considered: ideas.length, note: picked.length ? null : "Filtreleri geçen pozitif beklentili yapı bulunamadı (BEKLE)." };
}

// Yönetim kuralları VERİ olarak tanımlıdır: mesajdaki metin ve karnedeki günlük simülasyon aynı kaynaktan gelir.
// tp: bu K/Z'ye ($/kontrat) ulaşınca kâr al · sl: bu K/Z'nin altına inince çık (negatif) · dte: vadeye bu kadar gün
// kalınca kapat · breakShort: dayanak kısa strike'ı aşarsa çık (kredili yapılar).
export function rulesFor(i) {
  const prem = Math.abs(i.debit) * 100;
  if (i.kind === "credit") {
    const stop = 2 * prem;
    return { tp: Math.round(0.5 * i.maxProfit), sl: stop < i.maxLoss * 0.9 ? -Math.round(stop) : null, dte: 21, breakShort: true };
  }
  if (i.code === "LONG_CALL" || i.code === "LONG_PUT") return { tp: Math.round(prem), sl: -Math.round(0.5 * prem), dte: 21, breakShort: false };
  return { tp: Math.round(0.75 * i.maxProfit), sl: -Math.round(0.5 * prem), dte: 10, breakShort: false };
}

export function manageRules(i) {
  const r = i.rules || rulesFor(i);
  if (i.kind === "credit") {
    const stopTxt = r.sl != null ? `zarar $${-r.sl}'a (2× kredi) ulaşırsa ya da kısa strike kırılırsa çık` : "kısa strike kırılırsa çık (maks zarar zaten sınırlı)";
    return `Maks kârın %50'sinde (+$${r.tp}) kapat · vadeye ${r.dte} gün kalınca kapat · ${stopTxt}`;
  }
  if (i.code === "LONG_CALL" || i.code === "LONG_PUT") return `+%100'de (+$${r.tp}) kapat · prim %50 erirse (−$${-r.sl}) çık · vadeye ${r.dte} gün kalınca kapat (zaman erimesi hızlanır)`;
  return `Maks kârın %75'inde (+$${r.tp}) kapat · ödenen primin %50'si giderse (−$${-r.sl}) çık · vadeye ${r.dte} gün kalınca kapat`;
}

export { STRAT };
