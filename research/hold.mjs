#!/usr/bin/env node
// 1–2 AY TUTUŞ ÖLÇÜMÜ (bot/hold.mjs ile AYNI kural). Likit ilk 150 S&P 500 hissesi, 2014 sonrası günlük (Yahoo).
// Evren HER TARİHTE o günün 60 günlük işlem hacmine göre seçilir (bugünün S&P 500'ünden ilk 150) — bugünkü hacme göre seçmek
// geçmişin kazananlarını öne çıkarır ve momentumu şişirirdi.
// Her 21 işlem gününde bir (çakışmayan aylar) liste kurulur: ilk 10 (sektör ≤ 2), 21 ve 42 gün tutulur.
// Kıyas: aynı gün aynı evrendeki TÜM uygun hisselerin eşit ağırlıklı ortalaması → "fazla getiri".
// Walk-forward: ayların ilk %60'ı eğitim (en iyi varyant seçilir), son %40'ı test (hiç görülmeden sınanır).
// ⚠ Hayatta kalma yanlılığı: evren BUGÜNÜN S&P 500'ü → mutlak getiriler şişer; fazla getiri (aynı evrene karşı) daha az etkilenir.
import { fetchHistory } from "../data/yahoo.mjs";
import { loadUniverse } from "../spot/scan.mjs";
import { HOLD, HOLD_FILE, HOLD_LABEL, holdUniverse, indicators, holdPick, pickList } from "../bot/hold.mjs";
import { saveFiles, gistEnabled } from "../bot/state.mjs";

const U = loadUniverse(), NU = +(process.env.HOLD_N || HOLD.N_UNI), syms = holdUniverse(U, 1000);
const day = r => new Date(r.ts).toISOString().slice(0, 10);
const spy = await fetchHistory("SPY", "2014-01-01");
if (spy.length < 600) { console.log("SONUÇ\nHata: SPY verisi yok"); process.exit(1); }
const D = {};
for (let b = 0; b < syms.length; b += 6) {
  await Promise.all(syms.slice(b, b + 6).map(async s => {
    const rows = await fetchHistory(s, "2014-01-01").catch(() => []);
    if (rows.length <= 300) return;
    const dv = new Array(rows.length).fill(null); let acc = 0;
    for (let j = 0; j < rows.length; j++) { acc += rows[j].close * (rows[j].volume || 0); if (j >= 60) acc -= rows[j - 60].close * (rows[j - 60].volume || 0); if (j >= 59) dv[j] = acc / 60; }
    D[s] = { rows, dv, ind: indicators(rows), at: new Map(rows.map((r, j) => [day(r), j])) };
  }));
}
const dates = spy.map(day), sc = spy.map(r => r.close);
const rows = { S2: [], S2H: [], MOM: [] };
for (let t = 260; t + HOLD.H2 < spy.length; t += HOLD.H) {
  const d = dates[t], ir120 = sc[t] / sc[t - 120] - 1, all21 = [], all42 = [], cands = { S2: [], S2H: [], MOM: [] };
  const live = Object.entries(D).map(([s, x]) => [s, x, x.at.get(d)]).filter(([, x, j]) => j != null && j >= 252 && x.dv[j] > 0)
    .sort((a, b) => b[1].dv[b[2]] - a[1].dv[a[2]]).slice(0, NU);                       // o günün en likit NU hissesi
  for (const [s, x, j] of live) {
    const j21 = x.at.get(dates[t + HOLD.H]), j42 = x.at.get(dates[t + HOLD.H2]);
    if (j21 == null || j42 == null) continue;
    const c = x.rows[j].close, f21 = x.rows[j21].close / c - 1, f42 = x.rows[j42].close / c - 1;
    if (!(c >= HOLD.MIN_PX) || !isFinite(f21) || !isFinite(f42) || Math.abs(f21) > 2) continue;     // bozuk veri (bölünme hatası) ele
    all21.push(f21); all42.push(f42);
    for (const v of HOLD.VARIANTS) { const p = holdPick(v, x.rows, x.ind, j, ir120); if (p) cands[v].push({ sym: s, sec: U.meta?.[s]?.sec, f21, f42, ...p }); }
  }
  if (all21.length < 50) continue;
  const avg = a => a.reduce((p, q) => p + q, 0) / a.length, b21 = avg(all21), b42 = avg(all42);
  for (const v of HOLD.VARIANTS) {
    const top = pickList(cands[v], HOLD.TOP);
    if (top.length >= 3) rows[v].push({ d, ex: avg(top.map(x => x.f21)) - b21, ex42: avg(top.map(x => x.f42)) - b42, raw: avg(top.map(x => x.f21)), n: top.length });
  }
}
const stat = xs => { const n = xs.length, m = n ? xs.reduce((a, x) => a + x.ex, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x.ex - m) ** 2, 0) / (n - 1)) : 0;
  return { n, ex: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, win: n ? xs.filter(x => x.ex > 0).length / n : 0, ex42: n ? xs.reduce((a, x) => a + x.ex42, 0) / n : 0, raw: n ? xs.reduce((a, x) => a + x.raw, 0) / n : 0 }; };
const p = x => `${x >= 0 ? "+" : "−"}%${Math.abs(x * 100).toFixed(2)}`;
const res = {};
console.log(`SONUÇ — 1–2 AY TUTUŞ (her tarihte o günün en likit ${NU} hissesi, ${Object.keys(D).length} S&P 500 hissesi içinden; ${rows.S2[0]?.d ?? "?"} → ${rows.S2.at(-1)?.d ?? "?"}; ilk 10, sektör ≤ 2; kıyas: aynı evren eşit ağırlık)`);
for (const v of HOLD.VARIANTS) {
  const xs = rows[v], k = Math.floor(xs.length * 0.6), tr = stat(xs.slice(0, k)), te = stat(xs.slice(k));
  res[v] = { tr, te };
  console.log(`${HOLD_LABEL[v].padEnd(26)} EĞİTİM ${tr.n} ay: fazla ${p(tr.ex)}/ay t ${tr.t.toFixed(1)} · TEST ${te.n} ay: fazla ${p(te.ex)}/ay t ${te.t.toFixed(1)} · geçen ay %${Math.round(te.win * 100)} · 42 gün fazla ${p(te.ex42)}`);
}
const best = HOLD.VARIANTS.filter(v => res[v].tr.n >= 30).sort((a, b) => res[b].tr.ex - res[a].tr.ex)[0];
const te = best ? res[best].te : null, use = !!(te && res[best].tr.ex > 0 && te.n >= 20 && te.ex >= HOLD.MIN_EX && te.t >= HOLD.MIN_T && te.ex42 > 0);
console.log(best ? `SEÇİLEN (eğitimde en iyi): ${HOLD_LABEL[best]} → testte ${use ? "GEÇTİ → canlıda (haftalık liste)" : "GEÇMEDİ → liste gönderilmeyecek"}` : "SEÇİLEN: yok (veri yetersiz)");
console.log(["ÖZET", `🧪 1–2 ay tutuş testi (o günün en likit ${NU} hissesi, ${rows.S2.length} ay; son %40 hiç görülmeden sınandı)`,
  best ? `${use ? "✅" : "❌"} ${HOLD_LABEL[best]}: test ayda piyasadan ${p(te.ex)} fazla · ayların %${Math.round(te.win * 100)}'inde geçti${use ? " → canlıda, her hafta liste" : " → yeterli değil, liste gönderilmeyecek"}`
    : "❌ Veri yetersiz → liste gönderilmeyecek."].join("\n"));
if (gistEnabled() && process.env.HOLD_SAVE !== "0" && best)
  console.log((await saveFiles({ [HOLD_FILE]: { d: new Date().toISOString().slice(0, 10), use, variant: best, test: { ex: +te.ex.toFixed(4), t: +te.t.toFixed(2), win: +te.win.toFixed(3), n: te.n, ex42: +te.ex42.toFixed(4) } } })) ? "Sonuç Gist'e yazıldı." : "⚠ Sonuç yazılamadı.");
