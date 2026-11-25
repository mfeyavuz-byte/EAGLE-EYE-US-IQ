#!/usr/bin/env node
// HABER DUYGUSU ARAŞTIRMASI — olumlu/olumsuz başlık sonrası getiri farkı (SPY'a göre), işlem yapılabilir ölçüm:
//   Giriş = haberden sonra açılan ilk işlem gününün (tepki günü) kapanışı → yalnız "tepki sonrası sürüklenme" ölçülür.
//   Çıkış: giriş + 1 ve + 5 işlem günü kapanışı. Sembol-gün başına başlık puanları ortalanır (aynı haberin kopyaları tek sayılır).
// Karar: olumlu ile olumsuz arasındaki 5 günlük fark ≥ %0.30 VE iki grubun t-istatistikleri zıt yönde anlamlıysa (|t| ≥ 2)
//   "kurala eklenebilir"; değilse etiket yalnız BİLGİ olarak kalır.
// Çalıştırma: GitHub Actions → "Haber duygusu araştırması" (Alpaca anahtarı gerekir). Çıktı: Telegram + iş özeti.
import { newsRange, dailyBars, alpacaEnabled } from "../data/alpaca.mjs";
import { headlineScore } from "../bot/news.mjs";
import { nyParts } from "../data/market.mjs";

const SYMS = (process.env.NEWS_SYMS || "AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AVGO,AMD,NFLX,PLTR,COIN,MU,JPM,BAC,WFC,GS,XOM,CVX,UNH,LLY,JNJ,PFE,MRK,ABBV,WMT,COST,HD,NKE,DIS,BA,CAT,GE,INTC,ORCL,CRM,ADBE,QCOM,PYPL,UBER").split(",");
const DAYS = +(process.env.NEWS_DAYS || 180);

const nyD = ts => nyParts(new Date(ts)).date;
function stats(xs) {
  if (!xs.length) return { n: 0, m: null, t: null, hit: null };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return { n: xs.length, m, t: sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null, hit: xs.filter(x => x > 0).length / xs.length };
}
const pc = x => (x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%");
const f = (lab, s) => `${lab}: n ${s.n} · ort. ${pc(s.m)} · t ${s.t == null ? "—" : s.t.toFixed(2)} · pozitif %${s.hit == null ? "—" : Math.round(s.hit * 100)}`;

async function main() {
  if (!alpacaEnabled()) { console.log("SONUÇ\nAlpaca anahtarı yok — araştırma çalışamaz."); return; }
  const end = new Date(Date.now() - 864e5), start = new Date(end.getTime() - DAYS * 864e5);
  const bars = await dailyBars([...SYMS, "SPY"], Math.ceil(DAYS / 365) + 0.2);
  const idx = {};                                                           // sym → { dates[], close{} }
  for (const [s, arr] of Object.entries(bars)) { const ds = arr.map(b => nyD(b.ts)); idx[s] = { ds, c: Object.fromEntries(arr.map((b, i) => [ds[i], b.close])) }; }
  if (!idx.SPY) { console.log("SONUÇ\nSPY verisi alınamadı."); return; }
  const tdays = idx.SPY.ds;

  // Başlıkları sembol gruplarıyla çek (istek URL'si kısa kalsın)
  const heads = [];
  for (let i = 0; i < SYMS.length; i += 10) heads.push(...await newsRange(SYMS.slice(i, i + 10), start.toISOString(), end.toISOString(), 150));
  console.log(`Başlık: ${heads.length} · sembol ${SYMS.length} · ${DAYS} gün`);

  // Sembol-gün (giriş günü) başına ortalama puan
  const agg = new Map(), set = new Set(SYMS);
  for (const h of heads) {
    const sc = headlineScore(h.headline);
    if (!sc) continue;
    const ts = Date.parse(h.t), { date, mins } = nyParts(new Date(ts));
    let k = tdays.findIndex(d => d >= date);
    if (k < 0) continue;
    // Giriş = haberden SONRA açılan ilk günün (tepki günü) kapanışı: seans öncesi/içi haber → o gün; kapanış sonrası → ertesi gün;
    // hafta sonu/tatil → ilk işlem günü (k zaten o). Tepki fiyata girdikten sonra ölçülür → ileriye bakma yok.
    if (tdays[k] === date && mins >= 960) k++;
    if (k >= tdays.length) continue;
    for (const s of h.symbols) {
      if (!set.has(s)) continue;
      const key = `${s}|${tdays[k]}`, a = agg.get(key) || { s, k, sum: 0, n: 0 };
      a.sum += sc; a.n++; agg.set(key, a);
    }
  }
  const g = { pos: { r1: [], r5: [] }, neg: { r1: [], r5: [] }, all: { r1: [], r5: [] } };
  for (const a of agg.values()) {
    const sc = a.sum / a.n, I = idx[a.s];
    if (!I) continue;
    const d0 = tdays[a.k], d1 = tdays[a.k + 1], d5 = tdays[a.k + 5];
    const ex = d => (I.c[d] && I.c[d0] && idx.SPY.c[d] && idx.SPY.c[d0]) ? (I.c[d] / I.c[d0] - 1) - (idx.SPY.c[d] / idx.SPY.c[d0] - 1) : null;
    const r1 = d1 ? ex(d1) : null, r5 = d5 ? ex(d5) : null;
    const grp = sc >= 0.25 ? "pos" : sc <= -0.25 ? "neg" : null;
    for (const G of [grp, "all"].filter(Boolean)) { if (r1 != null) g[G].r1.push(r1); if (r5 != null) g[G].r5.push(r5); }
  }
  const P5 = stats(g.pos.r5), N5 = stats(g.neg.r5), spread = P5.m != null && N5.m != null ? P5.m - N5.m : null;
  const ok = spread != null && spread >= 0.003 && (P5.t ?? 0) >= 2 && (N5.t ?? 0) <= -2;
  console.log([
    "SONUÇ — HABER DUYGUSU (SPY'a göre fazla getiri, tepki sonrası)",
    `${SYMS.length} sembol · ${DAYS} gün · ${heads.length} başlık · ${agg.size} sembol-gün`,
    f("Olumlu · 1 gün", stats(g.pos.r1)), f("Olumlu · 5 gün", P5),
    f("Olumsuz · 1 gün", stats(g.neg.r1)), f("Olumsuz · 5 gün", N5),
    f("Tümü · 5 gün (kıyas)", stats(g.all.r5)),
    `Fark (olumlu − olumsuz, 5 gün): ${pc(spread)}`,
    ok ? "KARAR: anlamlı → kurala eklenebilir (onayınla)." : "KARAR: anlamlı DEĞİL → haber etiketi yalnız bilgi olarak kalır, kurala girmez.",
  ].join("\n"));
}
main().catch(e => { console.log("SONUÇ\nHata: " + (e?.message || e)); process.exit(1); });
