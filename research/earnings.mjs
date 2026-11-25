#!/usr/bin/env node
// BİLANÇO STRADDLE — GERİYE DÖNÜK TEST (Alpaca geçmiş opsiyon günlük mumları, 2024-02 sonrası).
// Olaylar: Nasdaq bilanço takvimi (gün gün tarama) ∩ likit büyük hisse listesi. Saat:
//   bmo → giriş D−1 kapanışı, çıkış D kapanışı · amc → giriş D, çıkış D+1 · saat yok → giriş D−1, çıkış D+1 (iki olasılığı da kapsar).
// Kontrat: çıkış gününden sonraki ilk Cuma (yoksa Perşembe) vadesi, girişteki fiyata en yakın, iki bacağı da işlem görmüş strike.
// Maliyet: iki bacağın kapanış fiyatı + %2 kayma (girişte), değer: kapanış − %2 (çıkışta). ⚠ Günlük kapanış = son işlem
//   fiyatıdır (alış-satış ortası değil) → gerçek dolum biraz farklı olabilir.
// Kural testi: fiyatlanan hareket ≤ 0.8 × aynı hissenin ÖNCEKİ (≥ 2) olaylarının ortalama gerçek tepkisi → "ucuz" alt kümesi.
import { dailyBars, optionBars, alpacaEnabled } from "../data/alpaca.mjs";
import { earningsOn } from "../data/nasdaq.mjs";
import { occ } from "../options/backtest.mjs";
import { nyParts } from "../data/market.mjs";

const SYMS = (process.env.ER_SYMS || "AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AVGO,AMD,NFLX,PLTR,COIN,MU,JPM,BAC,WFC,GS,MS,C,XOM,CVX,UNH,LLY,JNJ,PFE,MRK,ABBV,WMT,COST,HD,LOW,TGT,NKE,DIS,BA,CAT,DE,GE,INTC,ORCL,CRM,ADBE,QCOM,TXN,PYPL,UBER,SHOP,SNOW,PANW,CRWD,MRVL,ABNB,SBUX,MCD,KO,PEP,V,MA,AXP,IBM").split(",");
const START = process.env.ER_START || "2024-03-01", SLIP = 0.02, CHEAP = 0.8;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addD = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const nyD = ts => nyParts(new Date(ts)).date;

function stats(xs) {
  if (!xs.length) return "n 0";
  const s = [...xs].sort((a, b) => a - b), m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `n ${xs.length} · ort. ${(m * 100).toFixed(1)}% · medyan ${(s[Math.floor(s.length / 2)] * 100).toFixed(1)}% · kazanan %${Math.round(xs.filter(x => x > 0).length / xs.length * 100)}`;
}

async function main() {
  if (!alpacaEnabled()) { console.log("SONUÇ\nAlpaca anahtarı yok — test çalışamaz."); return; }
  const set = new Set(SYMS), events = [];
  const end = addD(new Date().toISOString().slice(0, 10), -3);
  for (let d = START; d <= end; d = addD(d, 1)) {
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const r of await earningsOn(d)) if (set.has(r.sym)) events.push({ sym: r.sym, D: d, time: r.time });
    await sleep(250);
  }
  console.log(`Olay: ${events.length} (${START} → ${end})`);
  const bars = await dailyBars(SYMS, 3);
  const idx = {};
  for (const [s, arr] of Object.entries(bars)) idx[s] = { ds: arr.map(b => nyD(b.ts)), c: arr.map(b => b.close) };

  const res = [], prior = {};
  for (const ev of events.sort((a, b) => a.D.localeCompare(b.D))) {
    const I = idx[ev.sym];
    if (!I) continue;
    const iD = I.ds.indexOf(ev.D);
    if (iD < 1 || iD + 1 >= I.ds.length) continue;
    const [iE, iX] = ev.time === "bmo" ? [iD - 1, iD] : ev.time === "amc" ? [iD, iD + 1] : [iD - 1, iD + 1];
    const E = I.ds[iE], X = I.ds[iX], S = I.c[iE];
    const realized = Math.abs(I.c[iX] / S - 1);
    // Vade: X'ten sonraki ilk Cuma (tatilse Perşembe)
    let fri = X; while (new Date(fri + "T12:00:00Z").getUTCDay() !== 5) fri = addD(fri, 1);
    const inc = S < 50 ? [1, 0.5, 2.5] : S < 200 ? [2.5, 1, 5] : S < 500 ? [5, 2.5, 10] : [10, 5];
    const Ks = [...new Set(inc.flatMap(st => [-1, 0, 1].map(k => +(Math.round(S / st) * st + k * st).toFixed(2))))].sort((a, b) => Math.abs(a - S) - Math.abs(b - S)).slice(0, 6);
    let got = null;
    for (const exp of [fri, addD(fri, -1)]) {
      const syms = Ks.flatMap(K => [occ(ev.sym, exp, "C", K), occ(ev.sym, exp, "P", K)]);
      const ob = await optionBars(syms, E, X);
      if (!ob) continue;
      for (const K of Ks) {
        const c = ob[occ(ev.sym, exp, "C", K)] || [], p = ob[occ(ev.sym, exp, "P", K)] || [];
        const cE = c.find(b => b.d === E), pE = p.find(b => b.d === E), cX = c.find(b => b.d === X), pX = p.find(b => b.d === X);
        if (cE && pE && cX && pX) { got = { K, exp, cost: (cE.c + pE.c) * (1 + SLIP), val: (cX.c + pX.c) * (1 - SLIP) }; break; }
      }
      if (got) break;
    }
    const hist = prior[ev.sym] || [];
    (prior[ev.sym] ||= []).push(realized);
    if (!got) continue;
    const implied = got.cost / S, ret = got.val / got.cost - 1;
    const avgPrior = hist.length >= 2 ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
    res.push({ ...ev, E, X, ret, implied, realized, cheap: avgPrior != null ? implied <= CHEAP * avgPrior : null });
  }
  const all = res.map(r => r.ret), cheap = res.filter(r => r.cheap === true).map(r => r.ret), dear = res.filter(r => r.cheap === false).map(r => r.ret);
  const mImp = res.length ? res.reduce((a, r) => a + r.implied, 0) / res.length : 0, mReal = res.length ? res.reduce((a, r) => a + r.realized, 0) / res.length : 0;
  const cm = cheap.length ? cheap.reduce((a, b) => a + b, 0) / cheap.length : null;
  console.log([
    "SONUÇ — BİLANÇO STRADDLE (yalnız alım: ATM call + put), giriş bilanço öncesi kapanış, çıkış tepki günü kapanışı",
    `${SYMS.length} hisse · ${START} sonrası · olay ${events.length} · fiyatı bulunan ${res.length}`,
    `Ortalama fiyatlanan hareket %${(mImp * 100).toFixed(1)} · ortalama gerçek tepki %${(mReal * 100).toFixed(1)}`,
    `Tümü: ${stats(all)}`,
    `UCUZ (fiyatlanan ≤ ${CHEAP} × önceki ort. tepki): ${stats(cheap)}`,
    `Pahalı: ${stats(dear)}`,
    cm == null ? "KARAR: ucuz alt kümede veri yok → canlı fikirler yalnız bilgi." : cm > 0.05 && cheap.length >= 20 ? "KARAR: ucuz straddle kuralı kârlı → canlı kural uygun." : "KARAR: ucuz straddle kuralı kâr ETMİYOR / veri az → canlı fikirleri küçük boyutla izle ya da kapat.",
  ].join("\n"));
}
main().catch(e => { console.log("SONUÇ\nHata: " + (e?.message || e)); process.exit(1); });
