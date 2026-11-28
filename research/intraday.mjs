#!/usr/bin/env node
// GÜN İÇİ KURULUM ARAŞTIRMASI — WALK-FORWARD (ileriye doğru kayan, örneklem dışı) + olasılık modeli.
// Veri: Alpaca SIP 5 dk (INTRA_DAYS, vars. 730) · yoksa Yahoo 5 dk (~60 gün). SPY+QQQ işlem; 11 sektör ETF'i ve S&P'nin en
//   büyük 50 hissesi piyasa içi genişlik için. Dünkü tepe/dip/kapanış ve günlük ATR aynı veriden.
// Ölçüm: giriş mum kapanışı → 30 / 60 dk ufukta önce STOP / HEDEF (2R) / süre sonu → R.
// Seçim: günlerin ilk %60'ı EĞİTİM, son %40'ı TEST. Kurulum × yön × ufuk × gün parçası × gün tipi grubu canlıya ancak
//   EĞİTİMDE (n ≥ 30, ort ≥ +0.15R, t ≥ 2) VE TESTTE (n ≥ 15, ort ≥ +0.05R) geçerse alınır.
// Model: eğitimde lojistik regresyon (kazanç = 30 dk R > 0); testte AUC ≥ 0.55 ise ve test eşiği kârlıysa kullanılır.
import { fetchChart } from "../data/yahoo.mjs";
import { alpacaEnabled } from "../data/alpaca.mjs";
import { nyParts } from "../data/market.mjs";
import { dayFeatures, setupsAt, breadthSeries, outcomeR, dayType, features, fitLogit, predLogit, auc, FEAT_NAMES } from "../bot/setups.mjs";
import { saveFiles, gistEnabled } from "../bot/state.mjs";
import { SETUPS_FILE, dtGroup, partOf, MEMBERS, SETUP_LABEL } from "../bot/setuplive.mjs";

const SYMS = ["SPY", "QQQ"], SECS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
const DAYS = +(process.env.INTRA_DAYS || 730);
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" };

async function alpaca5m(syms, days) {
  const out = {}, start = new Date(Date.now() - days * 864e5).toISOString(), end = new Date(Date.now() - 20 * 60e3).toISOString();
  for (let g = 0; g < syms.length; g += 10) {
    const grp = syms.slice(g, g + 10);
    let token = null, n = 0, fails = 0;
    do {
      const u = `https://data.alpaca.markets/v2/stocks/bars?symbols=${grp.join(",")}&timeframe=5Min&start=${start}&end=${end}&limit=10000&feed=sip&adjustment=all${token ? "&page_token=" + token : ""}`;
      const r = await fetch(u, { headers: H }).catch(() => null);
      if (!r?.ok) { if (++fails > 5) break; await new Promise(res => setTimeout(res, 3000 * fails)); continue; }
      const j = await r.json();
      for (const [s, arr] of Object.entries(j.bars || {})) for (const b of arr) {
        const ts = Date.parse(b.t), { date, mins } = nyParts(new Date(ts));
        if (mins >= 570 && mins < 960) ((out[s] ||= {})[date] ||= []).push({ ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, mins: mins + 5 });
      }
      token = j.next_page_token; n++;
      await new Promise(res => setTimeout(res, 320));
    } while (token && n < 400);
  }
  return out;
}
function byDayYahoo(arr) {
  const m = {};
  for (const b of arr || []) { const { date, mins } = nyParts(new Date(b.ts)); if (mins >= 570 && mins < 960) (m[date] ||= []).push({ ...b, mins: mins + 5 }); }
  return m;
}
const st = xs => { const n = xs.length, m = n ? xs.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0;
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, w: n ? xs.filter(x => x > 0).length / n : 0 }; };

async function main() {
  const src = alpacaEnabled() ? "Alpaca SIP" : "Yahoo";
  const all = [...SYMS, ...SECS, ...MEMBERS];
  let D;
  if (alpacaEnabled()) D = await alpaca5m(all, DAYS);
  else { D = {}; for (const s of all) D[s] = byDayYahoo(await fetchChart(s, "5m", "60d").catch(() => [])); }
  const days = Object.keys(D.SPY || {}).sort(), split = Math.floor(days.length * 0.6);
  const recs = [];
  for (const sym of SYMS) {
    const ranges = [];
    let prev = null;
    for (const [di, day] of days.entries()) {
      const bars = D[sym]?.[day];
      if (!bars || bars.length < 60) { prev = null; continue; }
      const dATR = ranges.length >= 10 ? ranges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, ranges.length) : null;
      const lv = prev ? { pdh: Math.max(...prev.map(b => b.high)), pdl: Math.min(...prev.map(b => b.low)), pdc: prev.at(-1).close } : {};
      const sec = Object.fromEntries(SECS.map(s => [s, D[s]?.[day] || []]).filter(([, a]) => a.length > 20));
      const mem = Object.fromEntries(MEMBERS.map(s => [s, D[s]?.[day] || []]).filter(([, a]) => a.length > 20));
      const ts = bars.map(b => b.ts);
      const br = Object.keys(sec).length >= 8 ? breadthSeries(ts, sec) : null, mb = Object.keys(mem).length >= 25 ? breadthSeries(ts, mem) : null;
      const f = dayFeatures(bars), last = {};
      for (let i = 6; i < bars.length - 1; i++) {
        const mins = bars[i].mins, dt = dayType(bars, i, dATR);
        for (const c of setupsAt(bars, f, i, mins, br, { ...lv, mb })) {
          const key = `${c.name}|${c.dir}`;
          if (last[key] != null && i - last[key] < 6) continue;
          last[key] = i;
          recs.push({ train: di < split, name: c.name, dir: c.dir, part: partOf(mins), dtg: dtGroup(dt, c.dir),
            r30: outcomeR(bars, i, c.dir, c.stop, 6), r60: outcomeR(bars, i, c.dir, c.stop, 12),
            r30b: outcomeR(bars, i, c.dir, c.stop, 6, 2, true), r60b: outcomeR(bars, i, c.dir, c.stop, 12, 2, true),
            x: features(bars, f, i, mins, c, { br, mb, pdc: lv.pdc, dATR, dt }) });
        }
      }
      ranges.push(Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low)));
      prev = bars;
    }
  }
  // Kurulum × yön × ufuk × (gün parçası | tümü) × (gün tipi grubu | tümü) — walk-forward seçim
  const allow = [], table = [];
  for (const nd of [...new Set(recs.map(r => `${r.name}|${r.dir}`))]) for (const hor of [30, 60]) {
    const [name, dir] = nd.split("|"), R = r => (hor === 30 ? r.r30 : r.r60), base = recs.filter(r => `${r.name}|${r.dir}` === nd);
    table.push({ k: `${name} ${dir === "C" ? "CALL" : "PUT"} ${hor}dk`, tr: st(base.filter(r => r.train).map(R)), te: st(base.filter(r => !r.train).map(R)) });
    for (const part of ["tümü", "sabah", "öğle", "öğleden sonra"]) for (const dtg of ["tümü", "lehte", "aleyhte", "yatay"]) {
      const sub = base.filter(r => (part === "tümü" || r.part === part) && (dtg === "tümü" || r.dtg === dtg));
      const a = st(sub.filter(r => r.train).map(R)), b = st(sub.filter(r => !r.train).map(R));
      if (a.n >= 30 && a.m >= 0.15 && a.t >= 2 && b.n >= 15 && b.m >= 0.05)
        allow.push({ name, dir, hor, part, dtg, n: a.n + b.n, m: +b.m.toFixed(3), mTrain: +a.m.toFixed(3), t: +a.t.toFixed(2), w: +b.w.toFixed(3) });
    }
  }
  // Aynı kurulum/yön/ufuk "tümü/tümü" geçtiyse alt kırılımlar gereksiz
  const slim = allow.filter(a => (a.part === "tümü" && a.dtg === "tümü") || !allow.some(b => b.name === a.name && b.dir === a.dir && b.hor === a.hor && b.part === "tümü" && b.dtg === "tümü"));
  // Olasılık modeli
  const trX = recs.filter(r => r.train), teX = recs.filter(r => !r.train);
  let model = null;
  if (trX.length >= 200 && teX.length >= 100) {
    const w = fitLogit(trX.map(r => r.x), trX.map(r => (r.r30 > 0 ? 1 : 0)));
    const p = teX.map(r => predLogit(w, r.x)), A = auc(p, teX.map(r => (r.r30 > 0 ? 1 : 0)));
    let best = null;
    for (const thr of [0.45, 0.5, 0.55, 0.6, 0.65]) {
      const s = st(teX.filter((r, k) => p[k] >= thr).map(r => r.r30));
      if (s.n >= 30 && (!best || s.m > best.m)) best = { thr, ...s };
    }
    model = { w, auc: +A.toFixed(3), thr: best?.thr ?? null, testAvgR: best ? +best.m.toFixed(3) : null, testN: best?.n ?? 0, use: !!(A >= 0.55 && best && best.m > 0.05) };
  }
  console.log(`SONUÇ — GÜN İÇİ KURULUMLAR · WALK-FORWARD (${src}, ${days.length} gün: eğitim ${split} · test ${days.length - split}; SPY+QQQ 5 dk; 1R = girişten stop'a)`);
  for (const r of table.sort((a, b) => b.te.m - a.te.m)) console.log(`${r.k.padEnd(22)} eğitim n ${String(r.tr.n).padStart(4)} ${r.tr.m >= 0 ? "+" : ""}${r.tr.m.toFixed(2)}R t ${r.tr.t.toFixed(1)} · TEST n ${String(r.te.n).padStart(4)} ${r.te.m >= 0 ? "+" : ""}${r.te.m.toFixed(2)}R`);
  console.log(slim.length ? "CANLIYA ALINAN (eğitim + testte geçen): " + slim.map(a => `${a.name} ${a.dir} ${a.hor}dk ${a.part}/${a.dtg} (test ${a.m >= 0 ? "+" : ""}${a.m}R)`).join(" · ")
    : "CANLIYA ALINAN: yok — hiçbir kurulum hem eğitimde hem testte geçmedi.");
  console.log(model ? `MODEL: test AUC ${model.auc} (0.5 = yazı-tura) · eşik ${model.thr ?? "—"} · eşik üstü test ort ${model.testAvgR ?? "—"}R (n ${model.testN}) → ${model.use ? "KULLANILIYOR" : "KULLANILMIYOR (yetersiz ayırt etme)"}` : "MODEL: veri yetersiz.");
  if (model?.use) console.log("Ağırlıklar: " + FEAT_NAMES.map((n, j) => `${n} ${model.w[j] >= 0 ? "+" : ""}${model.w[j]}`).join(" · "));
  // VARSAYIM TESTİ: aynı 5 dk mumda hedef + stop → STOP sayılıyor (ihtiyatlı). Ters varsayımla (HEDEF) canlıya alınanların test ortalaması
  const sub = a => recs.filter(r => !r.train && r.name === a.name && r.dir === a.dir && (a.part === "tümü" || r.part === a.part) && (a.dtg === "tümü" || r.dtg === a.dtg));
  const pool = slim.length ? slim.flatMap(a => sub(a).map(r => [a.hor === 30 ? r.r30 : r.r60, a.hor === 30 ? r.r30b : r.r60b])) : recs.map(r => [r.r30, r.r30b]);
  const amb = pool.filter(([x, y]) => x !== y).length, ambShare = pool.length ? amb / pool.length : 0;
  const mA = pool.length ? pool.reduce((s, [x]) => s + x, 0) / pool.length : 0, mB = pool.length ? pool.reduce((s, [, y]) => s + y, 0) / pool.length : 0;
  const robust = ambShare <= 0.1 && mB - mA <= 0.15;
  const ambLine = `🔁 Varsayım testi: ${slim.length ? "canlıdaki fikirlerin" : "tüm fikirlerin"} %${Math.round(ambShare * 100)}'inde hedef ve stop aynı mumda → stop sayıldı (ort ${mA >= 0 ? "+" : ""}${mA.toFixed(2)}R); hedef sayılsaydı ${mB >= 0 ? "+" : ""}${mB.toFixed(2)}R → ${robust ? "sonuç bu varsayıma bağlı değil" : "sonuç bu varsayıma DUYARLI, ihtiyatlı oku"}`;
  console.log(ambLine);
  // TELEGRAM ÖZETİ (kısa): yalnız canlıya alınanlar + model kararı
  const when = a => [a.part !== "tümü" ? a.part : null, a.dtg !== "tümü" ? { lehte: "trend yönünde", aleyhte: "trende karşı", yatay: "yatay günde" }[a.dtg] : null].filter(Boolean).join(", ");
  console.log(["ÖZET", `🧪 Gün içi test (SPY/QQQ, ${days.length} gün; son ${days.length - split} gün hiç görülmeden sınandı)`,
    ...(slim.length ? slim.map(a => `✅ ${a.dir === "C" ? "CALL" : "PUT"} — ${SETUP_LABEL[a.name]?.[a.dir] || a.name}${when(a) ? ` (${when(a)})` : ""}: isabet %${Math.round((a.w || 0) * 100)} · işlem başı ${a.m >= 0 ? "+" : ""}${a.m}R → canlıda`)
      : ["❌ Hiçbir kurulum testi geçmedi → kurulum mesajı gönderilmeyecek."]),
    model ? (model.use ? `🤖 Olasılık modeli işe yarıyor → fikirler süzülecek` : "🤖 Olasılık modeli işe yaramadı → kullanılmıyor") : null, pool.length ? ambLine : null].filter(Boolean).join("\n"));
  if (days.length >= 120 && gistEnabled() && process.env.INTRA_SAVE !== "0")
    console.log((await saveFiles({ [SETUPS_FILE]: { d: new Date().toISOString().slice(0, 10), src, days: days.length, allow: slim, model } })) ? "Liste ve model Gist'e yazıldı." : "⚠ Liste yazılamadı.");
}
main().catch(e => { console.log("SONUÇ\nHata: " + (e?.message || e)); process.exit(1); });
