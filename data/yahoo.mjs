// Yahoo Finance chart API (resmî değil, anahtarsız). Günlük + haftalık mum geçmişi.
// FAIL-SAFE: her hatada [] döner; çağıran sembolü atlar.
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };

async function yfetch(sym, interval, range, timeout = 8000) {
  for (const host of ["query1", "query2"]) {
    const u = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`;
    const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(u, { headers: UA, signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) continue;
      const j = await r.json();
      const n = j?.chart?.result?.[0];
      if (!n?.timestamp?.length) continue;
      const q = n.indicators.quote[0], rows = [];
      n.timestamp.forEach((ts, i) => {
        if (q.close[i] == null) return;
        const c = +q.close[i];
        rows.push({
          ts: ts * 1e3, date: "",
          open: +(+(q.open[i] ?? c)).toFixed(2), high: +(+(q.high[i] ?? c)).toFixed(2),
          low: +(+(q.low[i] ?? c)).toFixed(2), close: +c.toFixed(2), volume: q.volume[i] ?? 0,
        });
      });
      return rows;
    } catch { clearTimeout(tid); }
  }
  return [];
}

export const fetchDaily = sym => yfetch(sym, "1d", "2y");    // sinyal: ~500 günlük mum (MA200 geçerli)
export const fetchWeekly = sym => yfetch(sym, "1wk", "5y");  // üst trend
