#!/usr/bin/env node
// Hisse evreni: S&P 500 (tamamı) + Nasdaq'ta işlem gören TÜM hisseler → likidite filtresi → spot/universe.json
// Toplam 3 istek, Yahoo'ya hiç istek yok (istek sınırına takılmaz). Haftada bir workflow ile yenilenir.
//  - S&P 500 üyeleri: datasets/s-and-p-500-companies (GICS sektörü + CIK; CIK Faz 2'de SEC EDGAR için)
//  - Nasdaq üyeleri: nasdaqtrader.com resmî sembol dizini (ETF, test, sorunlu, varant/hak/birim/tercihli hariç)
//  - Fiyat/hacim/piyasa değeri: Nasdaq ekran listesi (tüm ABD hisseleri, tek istek)
// Likidite: S&P 500 üyeleri her zaman alınır. Nasdaq hisseleri: fiyat ≥ MIN_PRICE ve
//   (son gün işlem hacmi ≥ MIN_DV_M milyon $ VEYA piyasa değeri ≥ MIN_MCAP_B milyar $).
//   Kesin likidite kontrolü taramada 20 günlük ortalamayla yapılır (MIN_DVOL).
import { writeFile } from "node:fs/promises";

const MIN_DV_M = +(process.env.MIN_DV_M || 10);
const MIN_MCAP_B = +(process.env.MIN_MCAP_B || 2);
const MIN_PRICE = +(process.env.MIN_PRICE || 5);
const OUT = new URL("../spot/universe.json", import.meta.url);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function get(url, json = false) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/plain,*/*" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return json ? r.json() : r.text();
}

export function parseCSV(t) {
  const rows = [];
  for (const line of t.trim().split("\n")) {
    const cells = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur.replace(/\r$/, ""));
    rows.push(cells);
  }
  return rows;
}

const BAD_NAME = /\b(warrants?|rights?|units?|preferred|notes? due|debentures?|subordinated)\b/i;
const num = s => +(String(s ?? "").replace(/[$,%]/g, "")) || 0;

async function main() {
  // 1) S&P 500
  const sp = parseCSV(await get("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"));
  const head = sp.shift();
  const iSym = head.indexOf("Symbol"), iSec = head.indexOf("GICS Sector"), iCik = head.indexOf("CIK");
  const meta = {};
  for (const r of sp) if (r[iSym]) meta[r[iSym]] = { idx: "SP500", sec: r[iSec] || "", cik: +r[iCik] || null };
  const spCount = Object.keys(meta).length;
  if (spCount < 480) throw new Error(`S&P 500 listesi eksik (${spCount})`);

  // 2) Nasdaq resmî dizin
  const nq = (await get("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt")).trim().split("\n");
  const h = nq.shift().split("|"), c = k => h.indexOf(k);
  const nasdaq = new Set();
  for (const line of nq) {
    const f = line.split("|");
    const sym = f[c("Symbol")], name = f[c("Security Name")] || "";
    if (!sym || line.startsWith("File Creation")) continue;
    if (f[c("ETF")] === "Y" || f[c("Test Issue")] === "Y" || f[c("Financial Status")] !== "N") continue;
    if (BAD_NAME.test(name) || /[^A-Z]/.test(sym)) continue;
    nasdaq.add(sym);
  }
  if (nasdaq.size < 2000) throw new Error(`Nasdaq dizini eksik (${nasdaq.size})`);

  // 3) Fiyat / hacim / piyasa değeri (tüm ABD hisseleri)
  const scr = await get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true", true);
  const rows = scr?.data?.rows || [];
  if (rows.length < 3000) throw new Error(`Nasdaq ekran listesi eksik (${rows.length})`);
  const quote = {};
  for (const r of rows) quote[r.symbol.replace("/", ".")] = { px: num(r.lastsale), dv: num(r.lastsale) * num(r.volume), mcap: num(r.marketCap), sec: r.sector || "" };

  const keep = [];
  let spMissing = 0;
  for (const s of Object.keys(meta)) {
    const q = quote[s] || quote[s.replace(".", "-")];
    if (!q) spMissing++;
    keep.push({ s, dv: q?.dv || 0, mcap: q?.mcap || 0 });                 // S&P 500: her zaman
  }
  for (const s of nasdaq) {
    if (meta[s]) { meta[s].nasdaq = true; continue; }
    const q = quote[s];
    if (!q || q.px < MIN_PRICE) continue;
    if (q.dv < MIN_DV_M * 1e6 && q.mcap < MIN_MCAP_B * 1e9) continue;
    meta[s] = { idx: "NASDAQ", sec: q.sec, cik: null, nasdaq: true };
    keep.push({ s, dv: q.dv, mcap: q.mcap });
  }
  keep.sort((a, b) => b.dv - a.dv);                                       // likiditeye göre sırala (çekirdek = baştakiler)
  const out = {
    updated: new Date().toISOString(),
    rules: { MIN_DV_M, MIN_MCAP_B, MIN_PRICE },
    count: keep.length,
    symbols: keep.map(k => k.s),
    meta: Object.fromEntries(keep.map(k => [k.s, { ...meta[k.s], dv: Math.round(k.dv / 1e6), mcapB: +(k.mcap / 1e9).toFixed(1) }])),
  };
  await writeFile(OUT, JSON.stringify(out));
  const nNq = keep.filter(k => meta[k.s].idx === "NASDAQ").length;
  console.log(`✓ ${keep.length} sembol: S&P 500 ${spCount} (+ fiyatı bulunamayan ${spMissing}) + Nasdaq'tan ${nNq} (Nasdaq dizini ${nasdaq.size})`);
}

main().catch(e => { console.error("HATA:", e.message); process.exit(1); });
