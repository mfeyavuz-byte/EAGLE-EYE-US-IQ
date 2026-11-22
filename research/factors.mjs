#!/usr/bin/env node
// YÖN ARAŞTIRMASI — hangi sinyal/faktör, sinyalsiz rastgele seçimi gerçekten geçiyor?
// Her F_STEP işlem gününde en likit F_N hisse için: motorun sinyali + klasik faktörler + 21 gün sonraki getiri.
// Ölçü: KESİTSEL FAZLA GETİRİ = hissenin 21g getirisi − o gün evrenin ortalama 21g getirisi.
// Böylece piyasanın genel yönü ve (büyük ölçüde) hayatta kalan yanlılığı ölçüden çıkar.
// Çıktı: F_OUT (JSON) — research/evaluate.mjs okur.
import { writeFileSync } from "node:fs";
import { analyze, passes, loadUniverse } from "../spot/scan.mjs";
import { fetchChart } from "../data/yahoo.mjs";

const N = +(process.env.F_N || 300), STEP = +(process.env.F_STEP || 5), H = +(process.env.F_H || 21);
const START = process.env.F_START || "2023-06-01", OUT = process.env.F_OUT || "factors.json";
const iso = ts => new Date(ts).toISOString().slice(0, 10);

const { symbols, meta } = loadUniverse();
const uni = symbols.slice(0, N);
const t0 = Date.now();
const spy = await fetchChart("SPY", "1d", "5y");
const data = {};
for (let i = 0; i < uni.length; i += 8) await Promise.all(uni.slice(i, i + 8).map(async s => { data[s] = await fetchChart(s, "1d", "5y").catch(() => []); }));
console.log(`veri: ${Object.values(data).filter(d => d.length > 300).length}/${uni.length} · ${((Date.now() - t0) / 1e3).toFixed(0)}s`);

const spyI = new Map(spy.map((b, i) => [iso(b.ts), i]));
const days = spy.map(b => iso(b.ts));
const sma = (rows, k, n) => { let s = 0; for (let j = k - n + 1; j <= k; j++) s += rows[j].close; return s / n; };
const rows = [];
for (let di = 260; di < days.length - H; di += STEP) {
  const d = days[di];
  if (d < START) continue;
  const si = spyI.get(d);
  const spyRet60 = (spy[si].close / spy[si - 60].close - 1) * 100;
  const spyUp = spy[si].close > sma(spy, si, 200);
  const day = [];
  for (const s of uni) {
    const r = data[s];
    if (!r || r.length < 300) continue;
    let k = r.length - 1;
    while (k >= 0 && iso(r[k].ts) > d) k--;
    if (k < 260 || iso(r[k].ts) !== d || k + H >= r.length) continue;
    const c = r[k].close;
    const a = await analyze(s, { daily: r.slice(0, k + 1), spyRet60 }).catch(() => null);
    if (!a) continue;
    let hi = 0; for (let j = k - 251; j <= k; j++) hi = Math.max(hi, r[j].high);
    const rets = []; for (let j = k - 19; j <= k; j++) rets.push(Math.log(r[j].close / r[j - 1].close));
    const m = rets.reduce((x, y) => x + y, 0) / rets.length;
    // HACİMLİ ŞOK (bilanço/haber günü vekili): son 10 işlem gününde hacim ≥ 3× 50g ortalama olan en büyük
    // günlük hareket. shock = o günün getirisi (kapanış/önceki kapanış), shockAge = kaç gün önce, gap = açılış boşluğu.
    let shock = 0, shockAge = null, gap = 0;
    let v50 = 0; for (let j = k - 60; j < k - 10; j++) v50 += r[j].volume || 0; v50 /= 50;
    for (let j = k - 9; j <= k; j++) {
      const dr = r[j].close / r[j - 1].close - 1;
      if ((r[j].volume || 0) >= 3 * v50 && Math.abs(dr) > Math.abs(shock)) { shock = dr; shockAge = k - j; gap = r[j].open / r[j - 1].close - 1; }
    }
    day.push({
      d, s, sec: meta[s]?.sec || "?",
      sig: a.signal, conf: a.confidence, adx: a.adx, rsi: a.rsi, htf: a.htf, passed: passes(a), dv: a.dollarVol, px: c,
      mom12: r[k - 21].close / r[k - 252].close - 1, mom6: r[k - 21].close / r[k - 126].close - 1,
      ret21: c / r[k - 21].close - 1, ret5: c / r[k - 5].close - 1, rs60: a.rs60 / 100,
      hi52: c / hi, a200: c / sma(r, k, 200) - 1, a50: c / sma(r, k, 50) - 1,
      vol20: Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1) * 252),
      spyUp, spyRet60, shock, shockAge, gap,
      fwd: r[k + H].close / c - 1, fwd10: r[Math.min(k + 10, r.length - 1)].close / c - 1,
    });
  }
  const mean = day.reduce((x, y) => x + y.fwd, 0) / Math.max(1, day.length);
  day.forEach(x => { x.ex = x.fwd - mean; });
  rows.push(...day);
  process.stdout.write(`\r${d} · ${rows.length} satır · ${((Date.now() - t0) / 1e3).toFixed(0)}s   `);
}
writeFileSync(OUT, JSON.stringify(rows));
console.log(`\n${rows.length} satır → ${OUT}`);
