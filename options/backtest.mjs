#!/usr/bin/env node
// OPSİYON GERİYE DÖNÜK TEST — "spot sinyaline göre opsiyon ALMAK geçmişte para kazandırdı mı?"
//
// Yöntem (canlı botla aynı kurallar, geçmişe uygulanmış):
//  1) Her BT_STEP işlem gününde (varsayılan haftalık) en likit BT_N hisse o günün kapanışına kadarki veriyle analiz
//     edilir → o günün kesitsel momentum sırası → canlı seçim kuralı (spot/scan.mjs) → en iyi BT_AL AL + BT_SAT SAT (opsiyon likiditesi için
//     ort. işlem hacmi ≥ 150M$, fiyat ≥ $15).
//  2) AL → long call, SAT → long put. Vade: giriş gününden ≥ 35 gün sonraki ilk aylık vade (3. Cuma).
//     Strike: delta ≈ 0.60 (σ = 20 günlük gerçekleşen oynaklık ile), listelenmiş strike'lardan en yakını.
//  3) Giriş: sinyalden SONRAKİ günün kapanışı (ileriye bakma hatası yok). Fiyat: Alpaca geçmiş opsiyon mumu
//     (ücretsiz "indicative" akış, OPRA işlemlerinden türetilmiş).
//  4) Çıkış: canlı botun kuralı — +%100 kâr al · −%50 zarar durdur · vadeye 21 gün kala kapat (gün sonu kapanışlarıyla).
//  5) KONTROL GRUBU: aynı hisse, aynı gün, TERS yön (AL sinyaline put, SAT'a call). Sinyalin değeri varsa sinyal
//     tarafı kontrolü belirgin şekilde geçmelidir. Opsiyon alımının kendisi (oynaklık primi + spread) iki tarafa da
//     aynı maliyeti yükler; fark yalnız yönden gelir.
//  Maliyet: geçmişte alış/satış kotasyonu yok → işlem başına fiyatın BT_COST'u kadar kayma (giriş + çıkış), 0/%3/%6
//  duyarlılığıyla raporlanır.
//
// Sınırlar: evren BUGÜNÜN likit hisseleri (hayatta kalan yanlılığı); kapanış fiyatı son işlemdir (kotasyon değil);
// gün içi kâr al/zarar durdur tetiklenmesi görülmez.
//
// Çalıştırma: ALPACA_KEY_ID=… ALPACA_SECRET_KEY=… node options/backtest.mjs
// Ayarlar: BT_N=120 BT_START=2024-03-01 BT_END=(bugün−30g) BT_STEP=5 BT_AL=5 BT_SAT=3 BT_DELTA=0.6
import { writeFileSync } from "node:fs";
import { analyze, quality, loadUniverse, rankAndClassify, setMomCuts } from "../spot/scan.mjs";
import { fetchChart } from "../data/yahoo.mjs";
import { alpacaEnabled, optionBars } from "../data/alpaca.mjs";
import { bs, impliedVol } from "./bs.mjs";
import { hvC2C } from "./vol.mjs";

const E = (k, d) => (process.env[k] ? process.env[k] : d);
const N = +E("BT_N", 120), STEP = +E("BT_STEP", 5), NAL = +E("BT_AL", 5), NSAT = +E("BT_SAT", 3), DELTA = +E("BT_DELTA", 0.6);
const START = E("BT_START", "2024-03-01");
const END = E("BT_END", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
const R = 0.045, TP = 1.0, SL = -0.5, EXIT_DTE = 21, MIN_DTE = +E("BT_MIN_DTE", 35);   // LEAPS testi: BT_MIN_DTE=180
const COSTS = [0, 0.03, 0.06];
const OUT = E("BT_OUT", "");

const iso = ts => new Date(ts).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d + "T00:00:00Z") + n * 864e5);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

// Ayın 3. Cuması
function thirdFriday(y, m) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();          // 0 = Pazar
  return iso(Date.UTC(y, m, 1 + ((5 - first + 7) % 7) + 14));
}
export function pickExpiry(entry) {
  const [y, m] = entry.split("-").map(Number);
  for (let k = 0; k < 16; k++) {                                   // LEAPS için (BT_MIN_DTE=180) 15 aya kadar
    const f = thirdFriday(y + Math.floor((m - 1 + k) / 12), (m - 1 + k) % 12);
    if (dayDiff(entry, f) >= MIN_DTE) return f;
  }
  return null;
}
export const occ = (sym, exp, type, K) =>
  sym.replace(/[.\-]/g, "") + exp.slice(2, 4) + exp.slice(5, 7) + exp.slice(8, 10) + type + String(Math.round(K * 1000)).padStart(8, "0");

// Delta hedefine en yakın olası strike'lar (listelenme adımı bilinmediği için birkaç adım birlikte denenir).
export function strikeCands(type, S, T, sigma, target = DELTA, n = 8, incsIn = null) {
  const incs = incsIn || (S < 25 ? [0.5, 1] : S < 100 ? [1, 2.5, 5] : S < 250 ? [2.5, 5, 10] : [5, 10]);
  const set = new Set();
  for (const inc of incs) for (let K = Math.ceil(S * 0.7 / inc) * inc; K <= S * 1.3; K += inc) set.add(+K.toFixed(2));
  const want = type === "C" ? target : -target;
  return [...set].map(K => ({ K, err: Math.abs(bs(type, S, K, T, R, 0, sigma).delta - want) }))
    .sort((a, b) => a.err - b.err).slice(0, n).map(x => x.K);
}

// Çıkış kuralı seti: tp (+getiri), sl (−getiri), dte (vadeye kalan gün). null = o kural yok.
export const LIVE_RULE = { name: "CANLI: +%100 / −%50 / 21g", tp: TP, sl: SL, dte: EXIT_DTE };
export const RULE_VARIANTS = [
  LIVE_RULE,
  { name: "stopsuz: +%100 / — / 21g", tp: 1.0, sl: null, dte: 21 },
  { name: "geniş stop: +%100 / −%70 / 21g", tp: 1.0, sl: -0.7, dte: 21 },
  { name: "erken kâr: +%50 / −%50 / 21g", tp: 0.5, sl: -0.5, dte: 21 },
  { name: "kâr almasız: — / −%50 / 21g", tp: null, sl: -0.5, dte: 21 },
  { name: "yalnız süre: — / — / 21g", tp: null, sl: null, dte: 21 },
  { name: "erken süre: +%100 / −%50 / 30g", tp: 1.0, sl: -0.5, dte: 30 },
  { name: "+%150 / −%60 / 21g", tp: 1.5, sl: -0.6, dte: 21 },
];

// Bir kontratın gün gün yürüyüşü (kapanış fiyatlarıyla). Varsayılan: canlı botun kuralları.
export function walk(bars, entryDay, exp, rule = LIVE_RULE) {
  const i0 = bars.findIndex(b => b.d >= entryDay);
  if (i0 < 0 || !(bars[i0].c > 0)) return null;
  const entry = bars[i0];
  for (let i = i0 + 1; i < bars.length; i++) {
    const b = bars[i], ret = b.c / entry.c - 1;
    if (rule.tp != null && ret >= rule.tp) return { entry, exit: b, reason: "kâr hedefi" };
    if (rule.sl != null && ret <= rule.sl) return { entry, exit: b, reason: "zarar durdur" };
    if (rule.dte != null && dayDiff(b.d, exp) <= rule.dte) return { entry, exit: b, reason: "süre" };
  }
  const last = bars[bars.length - 1];
  return last && last !== entry ? { entry, exit: last, reason: dayDiff(last.d, exp) <= (rule.dte ?? 0) ? "süre" : "açık" } : null;
}
// Kaydedilmiş fiyat yolu ([[gün, kapanış], …]) üzerinde kural seti
export const walkPath = (path, exp, rule) => walk(path.map(([d, c]) => ({ d, c })), path[0]?.[0], exp, rule);

async function main() {
  const signalsOnly = process.env.BT_SIGNALS_ONLY === "1";
  if (!alpacaEnabled() && !signalsOnly) {
    console.error("ALPACA_KEY_ID / ALPACA_SECRET_KEY gerekli (geçmiş opsiyon fiyatları Alpaca'dan gelir). Yalnız sinyal üretimini denemek için BT_SIGNALS_ONLY=1.");
    process.exit(2);
  }
  const t0 = Date.now();
  const { symbols } = loadUniverse();
  const universe = symbols.slice(0, N);
  console.log(`Evren: en likit ${universe.length} hisse · ${START} → ${END} · her ${STEP} işlem günü · ${NAL} AL + ${NSAT} SAT`);

  // Günlük veri (5 yıl: göstergeler için giriş öncesi ~1 yıl gerekir)
  const data = {};
  const spy = await fetchChart("SPY", "1d", "5y");
  for (let i = 0; i < universe.length; i += 8) {
    await Promise.all(universe.slice(i, i + 8).map(async s => { data[s] = await fetchChart(s, "1d", "5y").catch(() => []); }));
  }
  const spyIdx = new Map(spy.map((b, i) => [iso(b.ts), i]));
  const days = spy.map(b => iso(b.ts)).filter(d => d >= START && d <= END);
  const entryDays = days.filter((_, i) => i % STEP === 0);
  console.log(`Veri: ${Object.values(data).filter(d => d.length > 300).length} hisse · ${entryDays.length} giriş günü · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);

  // 1) Sinyaller
  const picks = [];
  for (const d of entryDays) {
    const si = spyIdx.get(d);
    const spyRet60 = si >= 60 ? (spy[si].close / spy[si - 60].close - 1) * 100 : 0;
    const sig = [];
    for (const s of universe) {
      const rows = data[s];
      if (!rows || rows.length < 300) continue;
      let k = rows.length - 1;
      while (k >= 0 && iso(rows[k].ts) > d) k--;
      if (k < 260 || iso(rows[k].ts) !== d) continue;
      const a = await analyze(s, { daily: rows.slice(0, k + 1), spyRet60 }).catch(() => null);
      if (a) sig.push({ ...a, d, k });
    }
    rankAndClassify(sig);                                            // o günün kesitsel momentum sırası → seçim
    for (let i = sig.length - 1; i >= 0; i--) if (!(sig[i].passed && sig[i].dollarVol >= 150e6 && sig[i].price >= 15)) sig.splice(i, 1);
    sig.forEach(a => { a.q = quality(a); });
    sig.sort((a, b) => b.q - a.q);
    picks.push(...sig.filter(a => a.signal === "AL").slice(0, NAL), ...sig.filter(a => a.signal === "SAT").slice(0, NSAT));
  }
  console.log(`Sinyal: ${picks.length} (AL ${picks.filter(p => p.signal === "AL").length} · SAT ${picks.filter(p => p.signal === "SAT").length}) · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);
  if (signalsOnly) {
    // Opsiyonsuz kontrol: dayanağın 30 gün sonraki getirisi (sinyal yönünde)
    const fwd = picks.map(p => { const r = data[p.sym]; const j = Math.min(r.length - 1, p.k + 21); return (r[j].close / r[p.k].close - 1) * (p.signal === "AL" ? 1 : -1); });
    const avg = a => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length) * 100).toFixed(2) + "%";
    console.log(`Dayanak 21 işlem günü sonra (sinyal yönünde): ort ${avg(fwd)} · isabet ${(fwd.filter(x => x > 0).length / Math.max(1, fwd.length) * 100).toFixed(0)}%`);
    for (const s of ["AL", "SAT"]) { const g = picks.map((p, i) => [p, fwd[i]]).filter(([p]) => p.signal === s).map(x => x[1]); console.log(`  ${s}: ${g.length} · ort ${avg(g)} · isabet ${(g.filter(x => x > 0).length / Math.max(1, g.length) * 100).toFixed(0)}%`); }
    // Taban çizgisi: aynı günlerde evrendeki TÜM hisselerin 21 gün sonraki getirisi (sinyal yok)
    const base = [];
    for (const d of entryDays) for (const s of universe) {
      const r = data[s]; if (!r || r.length < 300) continue;
      const k = r.findIndex(x => iso(x.ts) === d); if (k < 0 || k + 21 >= r.length) continue;
      base.push(r[k + 21].close / r[k].close - 1);
    }
    console.log(`  TABAN (tüm hisseler, yukarı yönde): ${base.length} · ort ${avg(base)} · yükselen ${(base.filter(x => x > 0).length / Math.max(1, base.length) * 100).toFixed(0)}%`);
    return;
  }

  // 2) Opsiyonlar — sinyal tarafı + kontrol tarafı tek istekte
  const trades = [];
  let miss = 0, done = 0;
  const conc = 3;
  for (let i = 0; i < picks.length; i += conc) {
    await Promise.all(picks.slice(i, i + conc).map(async p => {
      const rows = data[p.sym], k = p.k;
      const entryDay = rows[k + 1] ? iso(rows[k + 1].ts) : null;    // sinyalden sonraki işlem günü
      if (!entryDay) { miss++; return; }
      const S = rows[k].close, exp = pickExpiry(entryDay);
      const sigma = Math.max(0.12, hvC2C(rows.slice(0, k + 1), 20) || 0.3);
      const T = dayDiff(entryDay, exp) / 365;
      const sides = { sig: p.signal === "AL" ? "C" : "P", ctl: p.signal === "AL" ? "P" : "C" };
      const cand = {};
      for (const [role, type] of Object.entries(sides)) cand[role] = strikeCands(type, S, T, sigma).map(K => ({ K, type, s: occ(p.sym, exp, type, K) }));
      let all = [...cand.sig, ...cand.ctl];
      let bars = await optionBars(all.map(c => c.s), entryDay, exp);
      // Tatil: 3. Cuma tatilse vade Perşembe
      if (bars && !Object.keys(bars).length) {
        const thu = addDays(exp, -1);
        for (const r of Object.values(cand)) r.forEach(c => { c.s = occ(p.sym, thu, c.type, c.K); });
        all = [...cand.sig, ...cand.ctl];
        bars = await optionBars(all.map(c => c.s), entryDay, thu);
      }
      if (!bars) { miss++; return; }
      const res = {};
      for (const role of ["sig", "ctl"]) {
        // strike'lar delta yakınlığına göre sıralı → giriş günü işlem görmüş ilk kontrat
        for (const c of cand[role]) {
          const b = bars[c.s];
          if (!b?.length || !b.some(x => x.d === entryDay && x.c > 0)) continue;
          const w = walk(b, entryDay, exp);
          if (w) { res[role] = { ...w, K: c.K, type: c.type, occ: c.s, path: b.filter(x => x.d >= w.entry.d).map(x => [x.d, x.c]) }; break; }
        }
      }
      if (!res.sig || !res.ctl) { miss++; return; }
      const und = d => rows.find(r => iso(r.ts) === d)?.close ?? null;
      // Faz 8: girişteki örtük oynaklık / gerçekleşen oynaklık ("ucuz IV'de al" testi)
      const Se = und(res.sig.entry.d) ?? S, Te = Math.max(1, dayDiff(res.sig.entry.d, exp)) / 365;
      const iv = impliedVol(res.sig.type, res.sig.entry.c, Se, res.sig.K, Te, R, 0);
      trades.push({
        sym: p.sym, signal: p.signal, conf: p.confidence, d: p.d, entryDay, exp, S, hv: +sigma.toFixed(4),
        ivhv: iv ? +(iv / sigma).toFixed(3) : null,
        sig: { ...res.sig, und: und(res.sig.exit.d) }, ctl: { ...res.ctl },
      });
      done++;
    }));
    if ((i / conc) % 20 === 0) process.stdout.write(`\r  opsiyon: ${done} işlem · ${miss} veri yok · ${((Date.now() - t0) / 1e3).toFixed(0)}s   `);
  }
  console.log(`\nİşlem: ${trades.length} · veri bulunamayan ${miss} · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);
  if (OUT) writeFileSync(OUT, JSON.stringify(trades));
  console.log("\n" + report(trades));
}

// Getiri: (çıkış·(1−c) − giriş·(1+c)) / (giriş·(1+c)) ; K/Z $ = 1 kontrat
export const retOf = (leg, c) => (leg.exit.c * (1 - c) - leg.entry.c * (1 + c)) / (leg.entry.c * (1 + c));
export const pnlOf = (leg, c) => (leg.exit.c * (1 - c) - leg.entry.c * (1 + c)) * 100;

export function summarize(legs, c) {
  const n = legs.length;
  if (!n) return null;
  const rets = legs.map(l => retOf(l, c)).sort((a, b) => a - b);
  const pnls = legs.map(l => pnlOf(l, c));
  const win = rets.filter(r => r > 0).length;
  const gp = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0), gl = -pnls.filter(x => x < 0).reduce((a, b) => a + b, 0);
  const prem = legs.reduce((a, l) => a + l.entry.c * 100, 0);
  return {
    n, winRate: win / n, avgRet: rets.reduce((a, b) => a + b, 0) / n, medRet: rets[Math.floor(n / 2)],
    pnl: pnls.reduce((a, b) => a + b, 0), prem, roi: pnls.reduce((a, b) => a + b, 0) / prem, pf: gl ? gp / gl : Infinity,
    days: legs.reduce((a, l) => a + dayDiff(l.entry.d, l.exit.d), 0) / n,
  };
}

const pc = v => (v * 100).toFixed(1) + "%";
const usd = v => (v >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US");
const line = (lab, s) => s ? `${lab.padEnd(22)} n=${String(s.n).padStart(4)} · kazanan ${pc(s.winRate).padStart(6)} · ort ${pc(s.avgRet).padStart(7)} · medyan ${pc(s.medRet).padStart(7)} · K/Z ${usd(s.pnl).padStart(9)} · prim getirisi ${pc(s.roi).padStart(7)} · PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)} · ${s.days.toFixed(0)}g` : `${lab.padEnd(22)} —`;

export function report(trades) {
  const L = [];
  const reasons = {};
  trades.forEach(t => { reasons[t.sig.reason] = (reasons[t.sig.reason] || 0) + 1; });
  L.push(`SONUÇ — ${trades.length} işlem (her biri 1 kontrat) · çıkış nedenleri: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  for (const c of COSTS) {
    L.push("", `── Maliyet: giriş+çıkışta fiyatın %${(c * 100).toFixed(0)}'i ──`);
    L.push(line("SİNYAL tarafı", summarize(trades.map(t => t.sig), c)));
    L.push(line("KONTROL (ters yön)", summarize(trades.map(t => t.ctl), c)));
    for (const s of ["AL", "SAT"]) {
      const g = trades.filter(t => t.signal === s);
      L.push(line(`  ${s === "AL" ? "AL → call" : "SAT → put"}`, summarize(g.map(t => t.sig), c)));
      L.push(line(`  ${s === "AL" ? "   kontrol put" : "   kontrol call"}`, summarize(g.map(t => t.ctl), c)));
    }
  }
  const c = 0.03;
  // ── Faz 8: girişteki IV/HV'ye göre (ucuz IV'de alım daha mı iyi?) ──
  if (trades.some(t => t.ivhv != null)) {
    L.push("", "── Girişte IV / gerçekleşen oynaklık (maliyet %3) ──");
    for (const [lo, hi, lab] of [[0, 0.9, "IV/HV < 0.9 (ucuz)"], [0.9, 1.1, "IV/HV 0.9–1.1"], [1.1, 1.3, "IV/HV 1.1–1.3"], [1.3, 99, "IV/HV > 1.3 (pahalı)"]]) {
      const g = trades.filter(t => t.ivhv != null && t.ivhv >= lo && t.ivhv < hi);
      L.push(line(`  ${lab}`, summarize(g.map(t => t.sig), c)));
    }
  }
  // ── Çıkış kuralı karşılaştırması: aynı fiyat yolları, farklı kurallar (maliyet %3) ──
  if (trades.some(t => t.sig.path)) {
    L.push("", "── ÇIKIŞ KURALLARI (aynı işlemler, maliyet %3) ──");
    const exp = t => t.exp;
    for (const rule of RULE_VARIANTS) {
      const legs = (side) => trades.map(t => t[side].path ? walkPath(t[side].path, exp(t), rule) : null).filter(Boolean);
      L.push(line(rule.name, summarize(legs("sig"), c)));
    }
    L.push("  (kontrol tarafı, aynı kurallar)");
    for (const rule of RULE_VARIANTS) {
      const legs = trades.map(t => t.ctl.path ? walkPath(t.ctl.path, exp(t), rule) : null).filter(Boolean);
      L.push(line("  " + rule.name, summarize(legs, c)));
    }
  }
  L.push("", "── Yıllara göre (maliyet %3) ──");
  for (const y of [...new Set(trades.map(t => t.d.slice(0, 4)))].sort()) {
    const g = trades.filter(t => t.d.startsWith(y));
    L.push(line(`  ${y} sinyal`, summarize(g.map(t => t.sig), c)), line(`  ${y} kontrol`, summarize(g.map(t => t.ctl), c)));
  }
  L.push("", "── Güvene göre (maliyet %3) ──");
  for (const [lo, hi] of [[0, 85], [85, 95], [95, 101]]) {
    const g = trades.filter(t => t.conf >= lo && t.conf < hi);
    L.push(line(`  güven ${lo}-${hi - 1} sinyal`, summarize(g.map(t => t.sig), c)), line(`  güven ${lo}-${hi - 1} kontrol`, summarize(g.map(t => t.ctl), c)));
  }
  return L.join("\n");
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error("FATAL", e); process.exit(1); });
