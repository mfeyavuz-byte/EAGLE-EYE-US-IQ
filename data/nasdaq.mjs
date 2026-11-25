// Nasdaq.com bilanço takvimi (herkese açık JSON, anahtarsız). FAIL-SAFE: hata → boş liste.
//  earningsOn(tarih)  → o gün açıklayacak şirketler + saat (bmo = açılış öncesi, amc = kapanış sonrası, null = belirtilmemiş)
//  reportDates(sembol) → son 4 açıklama tarihi
const H = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Accept: "application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function nget(url, tries = 3) {
  for (let a = 0; a < tries; a++) {
    const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { headers: H, signal: ctrl.signal });
      clearTimeout(tid);
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { clearTimeout(tid); await sleep(1000 * (a + 1)); }
  }
  return null;
}

const money = s => { const n = +String(s || "").replace(/[$,]/g, ""); return isFinite(n) && n > 0 ? n : null; };
export const timeOf = t => (t === "time-pre-market" ? "bmo" : t === "time-after-hours" ? "amc" : null);

export async function earningsOn(dateIso) {
  const j = await nget(`https://api.nasdaq.com/api/calendar/earnings?date=${dateIso}`);
  return (j?.data?.rows || []).map(r => ({ sym: String(r.symbol || "").trim().replace(/\//g, "."), time: timeOf(r.time), mcap: money(r.marketCap) }))
    .filter(r => r.sym);
}

// "10/28/2026" → "2026-10-28"
export const usDate = s => { const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };
export async function reportDates(sym) {
  const j = await nget(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym.replace(/\./g, "-"))}/earnings-surprise`);
  return (j?.data?.earningsSurpriseTable?.rows || []).map(r => usDate(r.dateReported)).filter(Boolean).sort();
}
