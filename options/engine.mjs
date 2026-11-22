// OPSİYON KARAR MOTORU
// 1) Yön: spot motorunun sinyali (AL/SAT/NÖTR) ve güveni → yön puanı (−1..+1)
// 2) Oynaklık rejimi: IV rank (geçmiş varsa) / IV÷HV (oynaklık risk primi) → ucuz | adil | zengin
// 3) Olay: bilanço vade içinde mi? Vade yapısı ters mi?
// 4) Yön × rejim matrisi → izin verilen stratejiler
// 5) Her aday: gerçekçi dolum, maks kâr/zarar, başabaş, piyasa POP'u, BİZİM POP'umuz ve beklenen değer
//    (kalın kuyruklu dağılım + gerçekleşen oynaklık + küçük sinyal eğimi), CVaR %5, Greek'ler
// 6) YÖNETİLEN İŞLEM simülasyonu (mesajdaki kurallarla gün gün) → yönetilen EV, kazanma oranı, süre, Kelly
// 7) Eleme: yönetilen EV < MIN_EDGE·maks zarar veya Kelly = 0 → elenir. Sıra: Kelly büyüme hızı. Boyut: ¼ Kelly (≤ %2)
import { loadChain } from "./chain.mjs";
import { volDashboard, atmIV } from "./vol.mjs";
import { candidates, STRAT } from "./strategies.mjs";
import { terminalDist, evaluate, skewK } from "./dist.mjs";
import { simulateManaged, kelly } from "./sim.mjs";
import { unusualOptions } from "./flow.mjs";

export const OCFG = {
  MIN_EDGE: +(process.env.OPT_MIN_EDGE || 0.03),     // EV / maks zarar ≥ %3
  ACCOUNT: +(process.env.OPT_ACCOUNT || 10000),      // boyutlandırma için hesap büyüklüğü ($)
  RISK: +(process.env.OPT_RISK || 0.02),             // işlem başına hesabın en çok %2'si riske
  // KALİBRE YÖN (başlangıç değeri; canlıda bot/calib.mjs günceller): O TARİHTEKİ S&P 500 üyeleriyle (hayatta
  // kalan yanlılığı yok) 21 günlük fazla getiri, ORTALAMA (kırpılmamış — alınan opsiyonun kazancı uç hareketlerden
  // gelir, bu yüzden uçları atmak opsiyon için yanlış olur):
  //   AL (günde ilk 10): +%1.5 / +%2.1 → ort. +%1.8/ay → YARISI +%0.9/ay ≈ yıllık +0.10
  //   SAT: −%0.7 / −%0.9 → ort. −%0.8/ay → YARISI −%0.4/ay ≈ yıllık −0.05
  // Yarıya indirme: aşırı uyum + rejim değişimi payı. Kayma = r − q ± bu fazla getiri.
  EDGE_AL: +(process.env.OPT_EDGE_AL || 0.10),
  EDGE_SAT: +(process.env.OPT_EDGE_SAT || 0.05),
  // Eski (kalibresiz) eğim: yalnız filtre bilgisi olmayan çağrılarda (testler) — score·TILT·σ/√T
  TILT: +(process.env.OPT_TILT || 0.15),
  // Vade yapısı (yakın IV / IV30). > INV → ters: oynaklık avantajı iddia edilmez (σ ≥ IV).
  // > INV_HARD → belirgin stres: iron condor (yönsüz prim satışı) yasak — büyük hareketler tam bu dönemlerde gelir.
  INV: +(process.env.OPT_INV || 1.1),
  INV_HARD: +(process.env.OPT_INV_HARD || 1.25),
  // Yön kaynaklı EV'ye ek güven çarpanı. Kalibre kayma zaten ölçülenin YARISI olduğundan varsayılan 1.
  // Canlı /spotkarne ölçülenden kötü çıkarsa düşürülür.
  DIR_TRUST: +(process.env.OPT_DIR_TRUST || 1),
  // KULLANICI KURALI: yalnızca opsiyon ALIMI (long call / long put). Hiçbir bacağı satış olan yapı önerilmez —
  // kredili spread, iron condor ve borçlu spread'ler (ikinci bacağı satış) dahil. OPT_LONG_ONLY=0 ile eski matris.
  LONG_ONLY: process.env.OPT_LONG_ONLY !== "0",
  // PUT ALIMI AÇIK (kullanıcı kuralı: yalnız SATIŞ/short yasak; long call ve long put serbest).
  // SAT seçimlerinde long put önerilir; yönetilen işlem simülasyonu + Kelly elemesi her fikre ayrıca uygulanır.
  // (Not: ilk opsiyon testinde SAT → put boğa piyasasında zarardaydı; canlı karne ve kalibrasyon bunu izler.)
  // OPT_PUTS=0 ile kapatılabilir.
  PUTS: process.env.OPT_PUTS !== "0",
  // Long opsiyon çıkış kuralı — opsiyon geriye dönük testi #4 (598 işlem, gerçek opsiyon fiyatları, maliyet %3):
  //   +%100 / −%50 / 21g (eski) −%6.1 prim getirisi · KÂR HEDEFİ YOK / −%50 / 21g −%2.8 (en iyi, PF 0.93)
  //   → kazananı erken satmak zararı ikiye katlıyordu; varsayılan: kâr hedefi yok.
  // LONG_TP: prim getirisi (1 = +%100; varsayılan "none" = kâr hedefi yok) · LONG_SL: prim kaybı (0.5 = −%50; "none" = stop yok)
  // LONG_DTE: vadeye bu kadar gün kala kapat
  LONG_TP: !process.env.OPT_LONG_TP || process.env.OPT_LONG_TP === "none" ? null : +process.env.OPT_LONG_TP,
  LONG_SL: process.env.OPT_LONG_SL === "none" ? null : +(process.env.OPT_LONG_SL || 0.5),
  LONG_DTE: +(process.env.OPT_LONG_DTE || 21),
  SIM_TOP: +(process.env.OPT_SIM_TOP || 15),         // dayanak başına simüle edilen en iyi aday sayısı
  SIM_N: +(process.env.OPT_SIM_N || 2000),           // senaryo sayısı
  KELLY_FRAC: +(process.env.OPT_KELLY_FRAC || 0.25), // ¼ Kelly (tahmin hatasına karşı)
};

// Canlı kalibrasyon (bot/calib.mjs) yön avantajını günceller. Ortam değişkeniyle elle verilmişse ona dokunulmaz.
export function setEdges(c) {
  if (!c) return;
  if (!process.env.OPT_EDGE_AL && isFinite(c.AL?.annual)) OCFG.EDGE_AL = c.AL.annual;
  if (!process.env.OPT_EDGE_SAT && isFinite(c.SAT?.annual)) OCFG.EDGE_SAT = c.SAT.annual;
}

// Spot analizinden yön. Seçim kuralını geçen hisse → kalibre fazla getiri (edge, yıllık). Geçmeyen → nötr.
export function directionOf(a) {
  if (a?.pick) {
    const up = a.pick === "AL";
    return { dir: up ? 1 : -1, score: up ? 1 : -1, edge: up ? OCFG.EDGE_AL : -OCFG.EDGE_SAT,
      label: up ? `YUKARI (momentum lideri geri çekilmede · mom12 ${a.mom12 != null ? "+" + Math.round(a.mom12 * 100) + "%" : "?"})` : `AŞAĞI (teyitli düşüş · güven %${a.confidence})` };
  }
  if (!a || a.signal === "NÖTR") return { dir: 0, score: 0, label: "NÖTR" };
  // Seçim kuralını geçmeyen sinyal yön sayılmaz.
  if (a.passed === false) return { dir: 0, score: 0, label: `NÖTR (motor ${a.engSignal ?? a.signal} %${a.confidence} · seçim kuralına uymuyor)` };
  const s = Math.max(0, Math.min(1, ((a.confidence || 50) - 50) / 50));
  if (s < 0.2) return { dir: 0, score: 0, label: "NÖTR (zayıf sinyal)" };
  return a.signal === "AL" ? { dir: 1, score: s, label: `YUKARI (AL %${a.confidence})` } : { dir: -1, score: -s, label: `AŞAĞI (SAT %${a.confidence})` };
}

// Yön × rejim matrisi (+ stres freni: vade yapısı belirgin tersse yönsüz prim satışı yok)
// Yalnız-alım modunda: yukarı → long call, aşağı → long put, yön yok → hiçbir şey. Pahalı oynaklıkta alım
// yasak değildir ama oynaklık maliyeti EV'yi düşürür; eleme bunu kendisi yapar.
export function allowedFor(dir, regime, ivhv, termRatio = null, longOnly = OCFG.LONG_ONLY) {
  if (longOnly) return new Set(dir > 0 ? ["LONG_CALL"] : dir < 0 && OCFG.PUTS ? ["LONG_PUT"] : []);
  if (dir > 0) return new Set(regime === "ucuz" ? ["LONG_CALL", "BULL_CALL"] : regime === "zengin" ? ["BULL_PUT", "BULL_CALL"] : ["BULL_CALL", "BULL_PUT"]);
  if (dir < 0) return new Set(regime === "ucuz" ? ["LONG_PUT", "BEAR_PUT"] : regime === "zengin" ? ["BEAR_CALL", "BEAR_PUT"] : ["BEAR_PUT", "BEAR_CALL"]);
  if (termRatio && termRatio > OCFG.INV_HARD) return new Set();
  if (regime === "zengin" || (regime === "adil" && (ivhv ?? 0) >= 1.1)) return new Set(["IRON_CONDOR"]);
  return new Set();
}

// Ana analiz. spot: spot/scan.mjs analyze() çıktısı; daily: günlük mumlar; hist: IV30 geçmişi.
export async function analyzeOptions(sym, { spot, daily, r, hist = null, top = 3 }) {
  // Alımda vade penceresi 35–120 gün (hedef ~60): zaman erimesinin yavaş olduğu bölge
  const chain = await loadChain(sym, r, OCFG.LONG_ONLY ? { minDte: 35, maxDte: 120, targets: [42, 63, 95] } : {});
  if (!chain || !chain.expiries.length) return { sym, error: "Opsiyon zinciri alınamadı (opsiyonu olmayan/illikit hisse olabilir)." };
  const vol = volDashboard(chain, daily, hist);
  const d = directionOf(spot);
  const allowed = allowedFor(d.dir, vol.regime, vol.ivhv, vol.termRatio);
  const stress = vol.termRatio && vol.termRatio > OCFG.INV_HARD;
  const reasons = [`Yön: ${d.label}`, `Oynaklık: ${vol.regime}${vol.rank != null ? ` (IV rank ${vol.rank})` : vol.ivhv ? ` (IV/HV ${vol.ivhv.toFixed(2)})` : ""}`];
  if (vol.termRatio && vol.termRatio > OCFG.INV) reasons.push(`Vade yapısı TERS (${vol.termRatio.toFixed(2)}) — yakın vadede olay/stres fiyatlanıyor${stress && !OCFG.LONG_ONLY ? "; yönsüz prim satışı (iron condor) yasak" : ""}`);
  if (Math.abs(chain.parityGap) >= 0.002) reasons.push(`Dayanak fiyatı zincirden (parite) alındı: $${chain.S.toFixed(2)} (kotasyon $${chain.Squote.toFixed(2)}, fark ${(chain.parityGap * 100).toFixed(2)}%)`);
  const base = { sym, S: chain.S, vol, dir: d, reasons, allowed: [...allowed], unusual: unusualOptions(chain) };
  if (chain.S < 10) return { ...base, ideas: [], note: "Fiyat < $10 — opsiyon spread'leri genelde verimsiz." };
  if (!allowed.size) return { ...base, ideas: [], note: d.dir === 0
    ? (OCFG.LONG_ONLY ? "Yön yok → opsiyon ALIMI için gerekçe yok (BEKLE). (Yalnız alım modu: satış içeren yapı önerilmez.)"
      : stress && (vol.regime === "zengin" || (vol.ivhv ?? 0) >= 1.1)
      ? "Oynaklık pahalı ama vade yapısı belirgin ters (stres) → yönsüz prim satışı yapılmaz (BEKLE)."
      : "Yön yok ve oynaklık pahalı değil → avantajlı opsiyon yapısı yok (BEKLE).")
    : d.dir < 0 && OCFG.LONG_ONLY && !OCFG.PUTS ? "SAT seçimi — put önerisi ayarla kapatılmış (OPT_PUTS=0). Spotta: çık / girme." : "Uygun yapı yok." };

  const now = Date.now();
  const ideas = [], pre = [];
  for (const ex of chain.expiries) {
    if (ex.dte < 14 || ex.dte > (OCFG.LONG_ONLY ? 130 : 75)) continue;   // işlem penceresi (alımda daha uzun vade)
    const expMs = ex.exp * 1e3 + 20 * 3600e3;
    const earnInside = chain.earningsTs && chain.earningsTs * 1e3 > now && chain.earningsTs * 1e3 < expMs;
    let allow = new Set(allowed);
    // Alınan tek opsiyon vadeye 21 gün kala kapatılır → en az 35 gün vade (en az ~2 hafta tutma süresi; zaman erimesi
    // son haftalarda hızlanır, alıcı kısa vadeden kaçınır).
    if (ex.dte < 35) { allow.delete("LONG_CALL"); allow.delete("LONG_PUT"); }
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
    // Kalibre yön varsa: yıllık fazla getiri (ölçülenin yarısı). Yoksa (eski çağrı): sinyal eğimi.
    const mu = mu0 + (d.edge != null ? d.edge : d.score * OCFG.TILT * sigP / Math.sqrt(ex.T));
    // Çarpıklık: piyasa dağılımı skew'un TAMAMINI, bizim dağılımımız %70'ini taşır
    // (put skew'unun bir kısmı tarihsel olarak risk primidir; tamamını yok saymak kuyruk riskini gizler).
    const kMkt = skewK(vol.skew, vol.iv30 || ivEx, 1), kPhys = skewK(vol.skew, vol.iv30 || ivEx, 0.7);
    const phys = terminalDist(chain.S, ex.T, sigP, mu, "t", 801, kPhys);
    const flat = d.score ? terminalDist(chain.S, ex.T, sigP, mu0, "t", 801, kPhys) : phys;   // yön eğimi olmadan (EV ayrıştırması)
    const mkt = terminalDist(chain.S, ex.T, ivEx, chain.r - chain.q, "lognormal", 801, kMkt);

    for (const c of candidates(ex, chain.S, allow)) {
      if (!isFinite(c.maxLoss) || c.maxLoss <= 0) continue;
      // Vade-sonu değerlendirmesi: ucuz ön eleme + model kalibrasyonu için (karne "vadeye kadar tutulmuş" kısmı)
      const e = evaluate(c.L, c.debit, phys);
      if (e.pop < (c.kind === "credit" ? 0.55 : 0.2)) continue;
      const evVol = flat === phys ? e.ev : evaluate(c.L, c.debit, flat).ev;   // oynaklık (+ maliyet) kaynaklı kısım
      const evAdj = evVol + OCFG.DIR_TRUST * (e.ev - evVol);                  // yön payı güven oranıyla
      const m = evaluate(c.L, c.debit, mkt);
      pre.push({ ...c, exp: ex.exp, dte: ex.dte, T: ex.T, expDate: new Date(ex.exp * 1e3).toISOString().slice(0, 10), ivEx, sigP, mu, mu0, earnInside,
        ev: e.ev, evVol, evDir: e.ev - evVol, evAdj, pop: e.pop, cvar5: e.cvar5, popMkt: m.pop, edge: e.ev / c.maxLoss, edgeAdj: evAdj / c.maxLoss });
    }
  }
  // İkinci emniyet: yalnız-alım modunda satış bacağı içeren hiçbir yapı listeye giremez.
  if (OCFG.LONG_ONLY) for (let k = pre.length - 1; k >= 0; k--) if (pre[k].legs.some(l => l.side < 0)) pre.splice(k, 1);

  // YÖNETİLEN İŞLEM: vade-sonu avantajı en iyi SIM_TOP aday, mesajdaki kurallarla gün gün simüle edilir.
  // Eleme ve sıralama BUNA göre: yönetilen EV (yön payı güven oranıyla) ≥ %MIN_EDGE·maks zarar, Kelly > 0;
  // sıra = Kelly büyüme hızı (gün başına) — sermayeyi en hızlı büyüten işlem önce.
  pre.sort((a, b) => b.edgeAdj - a.edgeAdj);
  for (const c of pre.slice(0, OCFG.SIM_TOP)) {
    const legs = c.legs.map(l => ({ type: l.type, K: l.K, side: l.side, iv: l.iv, sp: l.mid ? (l.ask - l.bid) / l.mid : 0 }));
    const rules = rulesFor(c);
    // Bilanço vade içinde → bilançodan 1 gün önce kapat (sonrasındaki IV çöküşüne girme). Elde tutma < 7 gün → aday değil.
    if (c.earnInside && chain.earningsTs) {
      const exitMs = chain.earningsTs * 1e3 - 864e5;
      rules.exitBy = new Date(exitMs).toISOString().slice(0, 10);
      rules.maxDays = Math.floor((exitMs - Date.now()) / 864e5);
      if (rules.maxDays < 7) continue;
    }
    const muSim = c.mu0 + OCFG.DIR_TRUST * (c.mu - c.mu0);
    const base = { S0: chain.S, T: c.T, sigma: c.sigP, r: chain.r, q: chain.q, legs, debit: c.debit, rules, n: OCFG.SIM_N };
    const sm = simulateManaged({ ...base, mu: muSim });
    const sv = d.score ? simulateManaged({ ...base, mu: c.mu0 }) : sm;
    const k = kelly(sm.pnls, c.maxLoss);
    const edgeM = sm.ev / c.maxLoss;
    if (sm.ev <= 0 || edgeM < OCFG.MIN_EDGE || k.f <= 0) continue;
    ideas.push({ ...c, rules, evM: sm.ev, evMVol: sv.ev, evMDir: sm.ev - sv.ev, popM: sm.pop, cvarM: sm.cvar5, daysM: sm.days,
      exitsM: sm.reasons, edgeM, kellyF: k.f, growth: k.g, score: k.g / Math.max(1, sm.days) - 0.1 * c.spreadAvg / Math.max(1, sm.days) });
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
    // Boyut: ¼ Kelly, üst sınır %RISK. Kelly küçükse risk de küçük — avantaj zayıfsa az pozisyon.
    i.riskFrac = Math.min(OCFG.RISK, OCFG.KELLY_FRAC * (i.kellyF ?? 0)) || OCFG.RISK;
    i.contracts = Math.floor(OCFG.ACCOUNT * i.riskFrac / i.maxLoss);
    i.minAccount = Math.ceil(i.maxLoss / i.riskFrac / 1000) * 1000;   // 1 kontrat için gereken hesap
    i.rules = i.rules || rulesFor(i);
    i.manage = manageRules(i);
  });
  return { ...base, ideas: picked, considered: pre.length, simulated: Math.min(pre.length, OCFG.SIM_TOP),
    note: picked.length ? null : `Yönetilen işlem simülasyonunda pozitif beklentili yapı yok (${Math.min(pre.length, OCFG.SIM_TOP)} aday simüle edildi) → BEKLE.` };
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
  if (i.code === "LONG_CALL" || i.code === "LONG_PUT") return {
    tp: OCFG.LONG_TP != null ? Math.round(OCFG.LONG_TP * prem) : null,
    sl: OCFG.LONG_SL != null ? -Math.round(OCFG.LONG_SL * prem) : null, dte: OCFG.LONG_DTE, breakShort: false };
  return { tp: Math.round(0.75 * i.maxProfit), sl: -Math.round(0.5 * prem), dte: 10, breakShort: false };
}

export function manageRules(i) {
  const r = i.rules || rulesFor(i);
  const earn = r.exitBy ? ` · ⚠ bilançodan önce, en geç ${r.exitBy.slice(8, 10)}.${r.exitBy.slice(5, 7)} kapanışında kapat (IV çöküşü)` : "";
  return manageText(i, r) + earn;
}
function manageText(i, r) {
  if (i.kind === "credit") {
    const stopTxt = r.sl != null ? `zarar $${-r.sl}'a (2× kredi) ulaşırsa ya da kısa strike kırılırsa çık` : "kısa strike kırılırsa çık (maks zarar zaten sınırlı)";
    return `Maks kârın %50'sinde (+$${r.tp}) kapat · vadeye ${r.dte} gün kalınca kapat · ${stopTxt}`;
  }
  if (i.code === "LONG_CALL" || i.code === "LONG_PUT") {
    const prem = Math.abs(i.debit) * 100;
    return [
      r.tp != null ? `+%${Math.round(r.tp / prem * 100)}'de (+$${r.tp}) kapat` : "kâr hedefi yok — kazananı taşı (testte erken kâr almak zararı ikiye katladı)",
      r.sl != null ? `prim %${Math.round(-r.sl / prem * 100)} erirse (−$${-r.sl}) çık` : "zarar durdurma yok (en çok ödenen prim kaybedilir)",
      `vadeye ${r.dte} gün kalınca kapat (zaman erimesi hızlanır)`,
    ].filter(Boolean).join(" · ");
  }
  return `Maks kârın %75'inde (+$${r.tp}) kapat · ödenen primin %50'si giderse (−$${-r.sl}) çık · vadeye ${r.dte} gün kalınca kapat`;
}

export { STRAT };
