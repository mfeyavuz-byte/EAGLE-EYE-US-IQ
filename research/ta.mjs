#!/usr/bin/env node
// TEKNİK FORMASYON ÖLÇÜMÜ (bot/ta.mjs ile AYNI kod). Bugünün S&P 500'ü, HER TARİHTE o günün en likit 150 hissesi (hacme göre).
// Günlük kalıplar (Elliott 2/4/ABC, düşen trend kırılımı, dipten dönüş): R sonucu (stop/hedef/20 gün; aynı mumda ikisi = stop) +
// 10 günlük fazla getiri (aynı günün evren ortalamasına göre, sinyal yönünde). Walk-forward: tarihlerin ilk %60'ı eğitim, son %40 test.
// Canlıya: eğitimde n ≥ 40, ort ≥ +0.10R, t ≥ 2 VE testte n ≥ 25, ort ≥ +0.05R, fazla getiri > 0.
// 200 haftalık ortalama olayları: 4 ve 13 haftalık fazla getiri (bilgi; uyarılar her durumda gider, mesajda bu ölçüm yazar).
import { fetchHistory, weeklyFromDaily } from "../data/yahoo.mjs";
import { loadUniverse } from "../spot/scan.mjs";
import { holdUniverse } from "../bot/hold.mjs";
import { TA, TA_FILE, TA_LABEL, WMA_LABEL, prep, taSignals, taOutcome, wmaArr, wmaEvent } from "../bot/ta.mjs";
import { saveFiles, gistEnabled } from "../bot/state.mjs";

const U = loadUniverse(), NU = +(process.env.TA_N || 150), syms = holdUniverse(U, 1000);
const day = ts => new Date(ts).toISOString().slice(0, 10);
const spy = await fetchHistory("SPY", "2010-01-01");
if (spy.length < 1500) { console.log("SONUÇ\nHata: SPY verisi yok"); process.exit(1); }
const dates = spy.map(r => day(r.ts)), di = new Map(dates.map((d, k) => [d, k])), START = dates.findIndex(d => d >= "2015-01-01");
const D = {};
for (let b = 0; b < syms.length; b += 6) await Promise.all(syms.slice(b, b + 6).map(async s => {
  const rows = (await fetchHistory(s, "2010-01-01").catch(() => [])).filter(r => r.close > 0 && r.high >= r.low);
  if (rows.length < 400) return;
  const dv = rows.map((_, j) => (j >= 59 ? rows.slice(j - 59, j + 1).reduce((a, r) => a + r.close * (r.volume || 0), 0) / 60 : 0));
  const at = rows.map(r => di.get(day(r.ts)) ?? -1);
  D[s] = { rows, dv, at, jOf: new Map(at.map((t, j) => [t, j])) };
}));
// Her tarihin en likit NU hissesi + o günün evren 10 günlük ortalama getirisi
const top = new Map(), base10 = new Map();
for (let t = START; t < dates.length - 11; t++) {
  const arr = [];
  for (const [s, x] of Object.entries(D)) { if (!x.jOf.has(t)) continue; const j = x.jOf.get(t); if (j >= 260 && x.dv[j] > 0 && x.rows[j + 10]) arr.push([s, j, x.dv[j]]); }
  arr.sort((a, b) => b[2] - a[2]);
  const sel = arr.slice(0, NU), f = sel.map(([s, j]) => D[s].rows[j + 10] ? D[s].rows[j + 10].close / D[s].rows[j].close - 1 : null).filter(v => v != null && Math.abs(v) < 1);
  top.set(t, new Set(sel.map(x => x[0])));
  base10.set(t, f.length ? f.reduce((a, v) => a + v, 0) / f.length : 0);
}
const split = START + Math.floor((dates.length - 11 - START) * 0.6);
const recs = [];
for (const [s, x] of Object.entries(D)) {
  const P = prep(x.rows);
  for (let j = 260; j < x.rows.length - TA.HOR - 1; j++) {
    const t = x.at[j];
    if (t < START || !top.get(t)?.has(s)) continue;
    for (const sg of taSignals(x.rows, P, j)) {
      const f10 = x.rows[j + 10].close / x.rows[j].close - 1;
      recs.push({ train: t < split, name: sg.name, dir: sg.dir, r: taOutcome(x.rows, j, sg), ex: (sg.dir === "C" ? 1 : -1) * (f10 - base10.get(t)), tr: sg.trend });
    }
  }
}
const st = a => { const n = a.length, m = n ? a.reduce((p, q) => p + q, 0) / n : 0, sd = n > 1 ? Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (n - 1)) : 0;
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, w: n ? a.filter(v => v > 0).length / n : 0 }; };
const allow = [], p = x => `${x >= 0 ? "+" : "−"}%${Math.abs(x * 100).toFixed(2)}`;
console.log(`SONUÇ — TEKNİK FORMASYONLAR (her gün en likit ${NU} hisse, ${Object.keys(D).length} S&P 500 hissesi içinden; ${dates[START]} → ${dates.at(-12)}; eğitim/test %60/%40)`);
for (const name of TA.NAMES) for (const dir of ["C", "P"]) for (const tf of ["tümü", "trendle"]) {
  const sub = recs.filter(r => r.name === name && r.dir === dir && (tf === "tümü" || r.tr === (dir === "C" ? 1 : -1)));
  const a = st(sub.filter(r => r.train).map(r => r.r)), b = st(sub.filter(r => !r.train).map(r => r.r)), ex = st(sub.filter(r => !r.train).map(r => r.ex));
  console.log(`${(name + " " + (dir === "C" ? "CALL" : "PUT") + " " + tf).padEnd(18)} EĞİTİM n ${String(a.n).padStart(5)} ${a.m >= 0 ? "+" : ""}${a.m.toFixed(2)}R t ${a.t.toFixed(1)} · TEST n ${String(b.n).padStart(4)} ${b.m >= 0 ? "+" : ""}${b.m.toFixed(2)}R isabet %${Math.round(b.w * 100)} · 10g fazla ${p(ex.m)}`);
  if (a.n >= 40 && a.m >= 0.1 && a.t >= 2 && b.n >= 25 && b.m >= 0.05 && ex.m > 0) allow.push({ name, dir, tf, n: a.n + b.n, m: +b.m.toFixed(3), w: +b.w.toFixed(3), ex: +ex.m.toFixed(4) });
}
// "tümü" geçtiyse "trendle" gereksiz
const slim = allow.filter(a => a.tf === "tümü" || !allow.some(b => b.name === a.name && b.dir === a.dir && b.tf === "tümü"));
// 200 haftalık ortalama
const W = { UP: [], DN: [], TOUCH: [], RETEST: [] };
const wk = {}; for (const [s, x] of Object.entries(D)) { const w = weeklyFromDaily(x.rows); wk[s] = { w, m: wmaArr(w) }; }
const wkBase = new Map();                                                   // hafta → evrenin 4/13 hafta ortalaması
for (const { w } of Object.values(wk)) for (let j = 0; j + 13 < w.length; j++) {
  const k = day(w[j].ts), o = wkBase.get(k) || { s4: 0, s13: 0, n: 0 };
  o.s4 += w[j + 4].close / w[j].close - 1; o.s13 += w[j + 13].close / w[j].close - 1; o.n++; wkBase.set(k, o);
}
const splitD = dates[split];
for (const [s, { w, m }] of Object.entries(wk)) for (let j = 0; j + 13 < w.length; j++) {
  if (day(w[j].ts) < "2015-01-01") continue;
  const e = wmaEvent(w, m, j); if (!e) continue;
  const b = wkBase.get(day(w[j].ts)), sg = e.dir === "C" ? 1 : -1;
  W[e.ev].push({ test: day(w[j].ts) >= splitD, x4: sg * (w[j + 4].close / w[j].close - 1 - b.s4 / b.n), x13: sg * (w[j + 13].close / w[j].close - 1 - b.s13 / b.n) });
}
const wma = {};
for (const [ev, a] of Object.entries(W)) {
  const all = st(a.map(r => r.x13)), te = st(a.filter(r => r.test).map(r => r.x13)), x4 = st(a.map(r => r.x4));
  wma[ev] = { n: all.n, x4: +x4.m.toFixed(4), x13: +all.m.toFixed(4), w13: +all.w.toFixed(3), testX13: +te.m.toFixed(4), testN: te.n };
  console.log(`200 HAFTALIK ${ev.padEnd(6)} n ${String(all.n).padStart(4)} · 4 hafta fazla ${p(x4.m)} · 13 hafta fazla ${p(all.m)} (geçen %${Math.round(all.w * 100)}) · test 13h ${p(te.m)} (n ${te.n})`);
}
console.log(slim.length ? "CANLIYA ALINAN: " + slim.map(a => `${a.name} ${a.dir} ${a.tf} (test ${a.m >= 0 ? "+" : ""}${a.m}R)`).join(" · ") : "CANLIYA ALINAN: yok");
const lab = a => `${a.dir === "C" ? "CALL" : "PUT"} — ${TA_LABEL[a.name][a.dir]}${a.tf === "trendle" ? " (kısa vadeli trend yönünde)" : ""}`;
console.log(["ÖZET", `🧪 Teknik formasyon testi (${Object.keys(D).length} büyük hisse, ${dates[START].slice(0, 4)} sonrası; son %40 hiç görülmeden sınandı)`,
  ...(slim.length ? slim.map(a => `✅ ${lab(a)}: isabet %${Math.round(a.w * 100)} · işlem başı +${a.m}R → canlıda`) : ["❌ Hiçbir formasyon testi geçmedi → formasyon mesajı gönderilmeyecek."]),
  ...Object.entries(wma).map(([ev, x]) => `📏 ${WMA_LABEL[ev]}: 13 haftada piyasadan ${p(x.x13)} (${x.n} olay) → ${x.x13 > 0 ? "işe yarıyor" : "zayıf, ihtiyatlı"}`)].join("\n"));
if (gistEnabled() && process.env.TA_SAVE !== "0")
  console.log((await saveFiles({ [TA_FILE]: { d: new Date().toISOString().slice(0, 10), allow: slim, wma } })) ? "Sonuç Gist'e yazıldı." : "⚠ Sonuç yazılamadı.");
