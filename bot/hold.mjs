// 1–2 AY TUTUŞ LİSTESİ (Stage-2: oturmuş yükseliş trendi) — günlük mum, saf fonksiyonlar (araştırma ve canlı AYNI kod).
// Canlıya yalnız research/hold.mjs ölçümü geçerse çıkar (abd_hold.json · use: true): eğitim dönemi en iyi varyantı seçer,
// görülmemiş test döneminde piyasadan (aynı evrenin eşit ağırlıklı ortalaması) ayda ≥ +%0.25 fazla ve t ≥ 1.5 olmalı.
// Varyantlar:
//   S2  : MA50 > MA200 · fiyat > MA50 · MA200 1 ayda yükselmiş · RSI 50–72 · ADX ≥ 20 · 6 ay SPY'dan güçlü
//         puan = 0.6·RS + 0.4·ADX + 10 (OBV birikimi) − 0.5·max(0, MA50'den uzaklık − %15)   (BIST botundaki kural)
//   S2H : S2 kapıları + 52 hafta zirvesinin en çok %15 altında · puan = 6 ay RS
//   MOM : MA50 > MA200 ve fiyat > MA200 · puan = 6 ay RS (sade momentum, kıyas)
// Stop (tez bozulması): MA50 × 0.97 altında kapanış. Sektör başına en çok 2 hisse.
export const HOLD_FILE = "abd_hold.json";
export const HOLD = { N_UNI: 150, TOP: 10, N_LIVE: 8, PER_SEC: 2, MIN_PX: 10, H: 21, H2: 42, MIN_EX: 0.0025, MIN_T: 1.5, VARIANTS: ["S2", "S2H", "MOM"] };
export const HOLD_LABEL = { S2: "Stage-2 trend", S2H: "Stage-2 + zirveye yakın", MOM: "6 ay momentum lideri" };

// Evren: likiditeye göre ilk N S&P 500 hissesi (araştırma ve canlı aynı tanım)
export const holdUniverse = (U, n = HOLD.N_UNI) =>
  Object.entries(U?.meta || {}).filter(([, m]) => m?.idx === "SP500" && m.dv > 0).sort((a, b) => b[1].dv - a[1].dv).slice(0, n).map(([s]) => s);

function smaArr(c, n) {
  const o = new Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) o[i] = s / n; }
  return o;
}
function rsiArr(c, n = 14) {
  const o = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; }
  }
  return o;
}
function adxArr(r, n = 14) {
  const len = r.length, o = new Array(len).fill(null);
  let tr = 0, pd = 0, md = 0, adx = null, dxs = [];
  for (let i = 1; i < len; i++) {
    const h = r[i].high, l = r[i].low, pc = r[i - 1].close, ph = r[i - 1].high, pl = r[i - 1].low;
    const t = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)), u = h - ph, d = pl - l;
    const p = u > d && u > 0 ? u : 0, m = d > u && d > 0 ? d : 0;
    if (i <= n) { tr += t; pd += p; md += m; if (i < n) continue; }
    else { tr = tr - tr / n + t; pd = pd - pd / n + p; md = md - md / n + m; }
    const pdi = tr ? 100 * pd / tr : 0, mdi = tr ? 100 * md / tr : 0, dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adx == null) { dxs.push(dx); if (dxs.length === n) adx = dxs.reduce((a, b) => a + b, 0) / n; }
    else adx = (adx * (n - 1) + dx) / n;
    o[i] = adx;
  }
  return o;
}
export function indicators(rows) {
  const c = rows.map(r => r.close), obv = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? 1 : c[i] < c[i - 1] ? -1 : 0) * (rows[i].volume || 0);
  return { c, ma50: smaArr(c, 50), ma200: smaArr(c, 200), rsi: rsiArr(c), adx: adxArr(rows), obv };
}

// i. gündeki karar (yalnız i ve öncesi kullanılır). ir120: SPY'ın 120 günlük getirisi. → { score, stop, rs, ext } | null
export function holdPick(variant, rows, ind, i, ir120) {
  if (i < 252 || !rows[i]) return null;
  const c = ind.c[i], m50 = ind.ma50[i], m200 = ind.ma200[i];
  if (!(c >= HOLD.MIN_PX) || !(m50 > 0) || !(m200 > 0) || !(ind.c[i - 120] > 0)) return null;
  const rs = c / ind.c[i - 120] - 1 - ir120, ext = c / m50 - 1;
  if (variant === "MOM") {
    if (!(m50 > m200 && c > m200 && rs > 0)) return null;
    return { score: rs, stop: +(m50 * 0.97).toFixed(2), rs, ext };
  }
  const p200 = ind.ma200[i - 21], adx = ind.adx[i] ?? 0, rsi = ind.rsi[i];
  if (!(m50 > m200 && c > m50 && p200 > 0 && m200 > p200 && rsi >= 50 && rsi <= 72 && adx >= 20 && rs > 0)) return null;
  if (variant === "S2H") {
    let hi = 0; for (let k = i - 251; k <= i; k++) hi = Math.max(hi, rows[k].high ?? rows[k].close);
    if (!(c >= 0.85 * hi)) return null;
    return { score: rs, stop: +(m50 * 0.97).toFixed(2), rs, ext };
  }
  const score = rs * 100 * 0.6 + adx * 0.4 + (ind.obv[i] > ind.obv[i - 21] ? 10 : 0) - Math.max(0, ext * 100 - 15) * 0.5;
  return { score, stop: +(m50 * 0.97).toFixed(2), rs, ext };
}

// En yüksek puanlılar, sektör başına en çok PER_SEC
export function pickList(cands, n = HOLD.TOP, perSec = HOLD.PER_SEC) {
  const out = [], cnt = {};
  for (const x of [...cands].sort((a, b) => b.score - a.score)) {
    const k = x.sec || x.sym;
    if ((cnt[k] || 0) >= perSec) continue;
    cnt[k] = (cnt[k] || 0) + 1; out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

// Haftanın Pazartesi tarihi (ISO) — "bu hafta liste gitti mi" anahtarı
export const weekKey = d => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };

const pct = x => `${x >= 0 ? "+" : "−"}%${Math.abs(x * 100).toFixed(2)}`;
export function fmtHold(list, cfg) {
  if (!list?.length) return null;
  const t = cfg?.test;
  return [`📈 1–2 AY TUTUŞ · ${HOLD_LABEL[cfg?.variant] || cfg?.variant}${t ? ` (test: ayda piyasadan ${pct(t.ex)} fazla · ayların %${Math.round(t.win * 100)}'inde geçti)` : ""}`,
    ...list.map(x => `${x.sym} ~${x.price.toFixed(2)} · stop ${x.stop.toFixed(2)}${x.contract ? ` · ${x.contract}` : ""}`),
    "Çıkış: kapanış stop altına inerse ya da ~2 ay dolunca."].join("\n");
}
