// FAZ 7 — YÖN MODELİNİ GÜÇLENDİRME: kalite + sektör rotasyonu (YUMUŞAK sıralama; sinyal silinmez, öncelik değişir).
//  • Sektör rotasyonu: 11 SPDR sektör ETF'inin 3 aylık (63 işlem günü) getirisi sıralanır. AL sinyali en zayıf 3 sektördeyse,
//    SAT sinyali en güçlü 3 sektördeyse listenin sonuna iner ve etiketlenir; güçlü sektördeki AL "güçlü sektör" etiketi alır.
//  • Kalite: AL adayları için kâr marjı, özsermaye kârlılığı, serbest nakit akışı, borç/özsermaye (Yahoo). Zarar eden ya da
//    nakit yakıp özsermaye kârlılığı negatif olan ya da borç/özsermaye > 300 olan → "zayıf kalite", sıranın sonuna.
// Günlük kota (en çok 10 AL) yüzünden sona inen sinyaller pratikte elenir; /sinyaller'de hepsi etiketiyle görünür.
// ⚠ Geçmiş temel veri ücretsiz olmadığından bu katman geriye dönük test EDİLEMEDİ; akademik bulgu (momentum + kalite)
//   ve sektör momentumuna dayanır. Spot karnesiyle canlı izlenir.
export const SECTOR_ETF = {
  "Information Technology": "XLK", Technology: "XLK", "Health Care": "XLV", "Consumer Discretionary": "XLY",
  "Communication Services": "XLC", Telecommunications: "XLC", "Consumer Staples": "XLP", Industrials: "XLI",
  Financials: "XLF", Finance: "XLF", Energy: "XLE", Materials: "XLB", "Basic Materials": "XLB", Utilities: "XLU", "Real Estate": "XLRE",
};
const ETFS = [...new Set(Object.values(SECTOR_ETF))];
const Q_TTL = 7 * 864e5, Q_MAX_FETCH = 25;

// closesOf(etf) → günlük kapanışlar. Dönüş: { d, r: {ETF: getiri}, top: [3], bottom: [3] } | null
export async function sectorRanks(closesOf, today) {
  const r = {};
  for (const e of ETFS) {
    const c = await closesOf(e).catch(() => []);
    if (c.length > 64) r[e] = c.at(-1) / c.at(-64) - 1;
  }
  const ord = Object.keys(r).sort((a, b) => r[b] - r[a]);
  if (ord.length < 8) return null;                                    // veri eksik → sektör katmanı bu gün kapalı
  return { d: today, r, top: ord.slice(0, 3), bottom: ord.slice(-3) };
}

// Zayıf kalite: true | false | null (veri yok)
export function weakQuality(q) {
  if (!q) return null;
  if (q.margin != null && q.margin < 0) return true;                                       // zarar ediyor
  if (q.fcf != null && q.fcf < 0 && q.roe != null && q.roe < 0) return true;              // nakit yakıyor + negatif ROE
  if (q.de != null && q.de > 300) return true;                                             // aşırı borç
  return q.margin == null && q.roe == null && q.fcf == null ? null : false;
}

// Saf sıralama (test edilebilir): sinyallere edgeTag ekler, AL/SAT grupları içinde kademeye göre KARARLI sıralar.
export function applyEdge(signals, { secOf, sectors, qualOf }) {
  const tier = new Map();
  for (const s of signals) {
    const etf = SECTOR_ETF[secOf(s.sym) || ""], tags = [];
    let t = 0;
    if (sectors && etf) {
      if (s.signal === "AL" && sectors.bottom.includes(etf)) { t++; tags.push(`⚠ zayıf sektör ${etf}`); }
      else if (s.signal === "AL" && sectors.top.includes(etf)) tags.push(`güçlü sektör ${etf}`);
      if (s.signal === "SAT" && sectors.top.includes(etf)) { t++; tags.push(`⚠ güçlü sektörde SAT (${etf})`); }
    }
    if (s.signal === "AL") {
      const w = weakQuality(qualOf(s.sym));
      if (w === true) { t++; tags.push("⚠ zayıf kalite"); } else if (w === false) tags.push("kalite ✓");
    }
    s.edgeTag = tags.join(" · ") || null;
    tier.set(s, t);
  }
  const grp = s => (s.signal === "AL" ? 0 : 1);
  return signals.map((s, i) => [s, i]).sort((a, b) => grp(a[0]) - grp(b[0]) || tier.get(a[0]) - tier.get(b[0]) || a[1] - b[1]).map(x => x[0]);
}

// Canlı: sektör sırası günde 1, kalite verisi sembol başına 7 günde 1 (çalıştırma başına en çok 25 istek). signals yerinde sıralanır.
export async function rankEdge(st, signals, { secOf, closesOf, qualityStats, today, now = Date.now() }) {
  if (!signals?.length) return signals;
  if (st.sectors?.d !== today) st.sectors = (await sectorRanks(closesOf, today).catch(() => null)) ?? { d: today, r: {}, top: [], bottom: [] };
  st.qual ||= {};
  let fetched = 0;
  for (const s of signals.filter(x => x.signal === "AL")) {
    const c = st.qual[s.sym];
    if (c && now - c.t < Q_TTL) continue;
    if (fetched++ >= Q_MAX_FETCH) break;
    const q = await qualityStats(s.sym).catch(() => null);
    if (q) st.qual[s.sym] = { t: now, q: { margin: q.margin, roe: q.roe, fcf: q.fcf, de: q.de } };
  }
  for (const [k, v] of Object.entries(st.qual)) if (now - v.t > 30 * 864e5) delete st.qual[k];   // durum dosyası şişmesin
  const sorted = applyEdge(signals, { secOf, sectors: st.sectors.top.length ? st.sectors : null, qualOf: s => st.qual[s]?.q ?? null });
  signals.splice(0, signals.length, ...sorted);
  return signals;
}

export function fmtSectors(sec) {
  if (!sec?.top?.length) return "Sektör rotasyonu: veri yok.";
  const p = e => `${e} ${sec.r[e] >= 0 ? "+" : ""}${(sec.r[e] * 100).toFixed(1)}%`;
  return `🧭 Sektör rotasyonu (3 ay): güçlü ${sec.top.map(p).join(", ")} · zayıf ${sec.bottom.map(p).join(", ")}`;
}
