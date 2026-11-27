#!/usr/bin/env node
// GÜN İÇİ KURULUM ARAŞTIRMASI — SPY/QQQ 5 dk mum, bot/setups.mjs kurulumları + mevcut 15 dk skoru (kıyas).
// Veri: Alpaca anahtarı varsa SIP 5 dk (INTRA_DAYS gün, vars. 365); yoksa Yahoo 5 dk (son ~60 gün).
// Ölçüm: giriş mum kapanışı; 30 dk ve 60 dk ufukta önce STOP / HEDEF (2R) / süre sonu → R katı. Aynı kurulum+sembol
//   30 dk'da bir kez. Sonuç: kurulum × yön başına n, isabet, ortalama R, toplam R; gün parçası (sabah/öğle/öğleden sonra).
import { fetchChart } from "../data/yahoo.mjs";
import { alpacaEnabled } from "../data/alpaca.mjs";
import { nyParts } from "../data/market.mjs";
import { dayFeatures, setupsAt, breadthSeries, outcomeR, SETUP_NAMES } from "../bot/setups.mjs";
import { idxSignal } from "../bot/idx15.mjs";
import { saveFiles, gistEnabled } from "../bot/state.mjs";
import { SETUPS_FILE, buildAllow } from "../bot/setuplive.mjs";

const SYMS = ["SPY", "QQQ"], SECS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
const DAYS = +(process.env.INTRA_DAYS || 365);
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" };

async function alpaca5m(syms, days) {
  const out = {}, start = new Date(Date.now() - days * 864e5).toISOString(), end = new Date(Date.now() - 20 * 60e3).toISOString();
  for (const s of syms) {
    let token = null, n = 0;
    do {
      const u = `https://data.alpaca.markets/v2/stocks/bars?symbols=${s}&timeframe=5Min&start=${start}&end=${end}&limit=10000&feed=sip&adjustment=all${token ? "&page_token=" + token : ""}`;
      const r = await fetch(u, { headers: H }).catch(() => null);
      if (!r?.ok) break;
      const j = await r.json();
      for (const b of j.bars?.[s] || []) (out[s] ||= []).push({ ts: Date.parse(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      token = j.next_page_token; n++;
      await new Promise(res => setTimeout(res, 300));
    } while (token && n < 50);
  }
  return out;
}

// Seans içi (09:30–16:00) mumları güne böl
function byDay(arr) {
  const m = {};
  for (const b of arr || []) { const { date, mins } = nyParts(new Date(b.ts)); if (mins >= 570 && mins < 960) (m[date] ||= []).push({ ...b, mins: mins + 5 }); }
  return m;
}

async function main() {
  const src = alpacaEnabled() ? "Alpaca SIP" : "Yahoo";
  const raw = alpacaEnabled() ? await alpaca5m([...SYMS, ...SECS], DAYS) : Object.fromEntries(await Promise.all([...SYMS, ...SECS].map(async s => [s, await fetchChart(s, "5m", "60d").catch(() => [])])));
  const D = Object.fromEntries(Object.entries(raw).map(([s, a]) => [s, byDay(a)]));
  const days = Object.keys(D.SPY || {}).sort();
  const res = {}, add = (k, r, part) => { (res[k] ||= { all: [], part: {} }).all.push(r); (res[k].part[part] ||= []).push(r); };
  for (const day of days) {
    const sec = Object.fromEntries(SECS.map(s => [s, D[s]?.[day] || []]).filter(([, a]) => a.length > 20));
    for (const sym of SYMS) {
      const bars = D[sym]?.[day];
      if (!bars || bars.length < 60) continue;
      const f = dayFeatures(bars), br = Object.keys(sec).length >= 8 ? breadthSeries(bars.map(b => b.ts), sec) : null;
      const last = {};
      for (let i = 6; i < bars.length - 1; i++) {
        const mins = bars[i].mins, part = mins < 690 ? "sabah" : mins < 840 ? "öğle" : "öğleden sonra";
        const cands = setupsAt(bars, f, i, mins, br);
        // Kıyas: mevcut 15 dk skoru (yalnız çeyrek saat kapanışlarında, 09:45–15:45)
        if (mins % 15 === 0 && mins >= 585 && mins <= 945) {
          const sg = idxSignal(bars.slice(0, i + 1), bars[i].close, null, null);
          if (sg?.dir) cands.push({ name: "ESKİ_SKOR", dir: sg.dir, stop: sg.stop });
        }
        for (const c of cands) {
          const key = `${c.name}|${c.dir}`;
          if (last[key] != null && i - last[key] < 6) continue;
          last[key] = i;
          add(`${c.name} ${c.dir === "C" ? "CALL" : "PUT"} · 30dk`, outcomeR(bars, i, c.dir, c.stop, 6), part);
          add(`${c.name} ${c.dir === "C" ? "CALL" : "PUT"} · 60dk`, outcomeR(bars, i, c.dir, c.stop, 12), part);
        }
      }
    }
  }
  const st = xs => { const n = xs.length, m = n ? xs.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0;
    return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, hit: n ? xs.filter(x => x >= 1.99).length / n : 0 }; };
  const rows = Object.entries(res).map(([k, v]) => ({ k, ...st(v.all), part: Object.fromEntries(Object.entries(v.part).map(([p, xs]) => [p, st(xs)])) }))
    .map(r => { const [name, dirTxt, hor] = r.k.split(/ · | /); return { ...r, name, dir: dirTxt === "CALL" ? "C" : "P", hor: parseInt(hor) }; })
    .sort((a, b) => b.m - a.m);
  console.log(`SONUÇ — GÜN İÇİ KURULUMLAR (${src}, ${days.length} gün, SPY+QQQ, 5 dk; R = girişten stop'a mesafe, hedef 2R)`);
  for (const r of rows) console.log(`${r.k.padEnd(26)} n ${String(r.n).padStart(4)} · hedef %${Math.round(r.hit * 100)} · ort ${r.m >= 0 ? "+" : ""}${r.m.toFixed(2)}R · t ${r.t.toFixed(1)} · ` +
    Object.entries(r.part).map(([p, s]) => `${p} ${s.n}/${s.m >= 0 ? "+" : ""}${s.m.toFixed(2)}R`).join(" "));
  console.log("Okuma: ort > +0.15R ve t ≥ 2 ve n ≥ 40 → canlıya alınabilir; t < 2 → şans olabilir.");
  // Canlıya alınacak liste (kurulum × yön × ufuk × gün parçası) → Gist (canlı bot okur). Yalnız yeterli veride (≥ 120 gün).
  const allow = buildAllow(rows);
  console.log(allow.length ? "CANLIYA ALINAN: " + allow.map(a => `${a.name} ${a.dir} ${a.hor}dk ${a.part} (n ${a.n}, ${a.m.toFixed(2)}R, t ${a.t.toFixed(1)})`).join(" · ")
    : "CANLIYA ALINAN: yok — hiçbir kurulum eşiği geçmedi (gönderim yapılmaz, yalnız ölçüm sürer).");
  if (days.length >= 120 && gistEnabled() && process.env.INTRA_SAVE !== "0")
    console.log((await saveFiles({ [SETUPS_FILE]: { d: new Date().toISOString().slice(0, 10), src, days: days.length, allow } })) ? "Liste Gist'e yazıldı." : "⚠ Liste yazılamadı.");
}
main().catch(e => { console.log("SONUÇ\nHata: " + (e?.message || e)); process.exit(1); });
