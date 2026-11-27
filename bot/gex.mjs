// GAMMA SEVİYELERİ (GEX) — SPY/QQQ opsiyon açık pozisyonlarından piyasa yapıcıların hedge baskısı (yaygın varsayım: müşteriler
// call alır/put alır → yapıcılar call'da kısa, put'ta uzun gamma'yı dengelemek için):
//   net GEX(S) = Σ call: γ·OI·100·S²·0.01 − Σ put: γ·OI·100·S²·0.01   (yakın vadeler, ≤ 35 gün)
//   • Gamma dönüşü (flip): net GEX'in sıfırı kestiği fiyat. Fiyat ÜSTÜNDE → hareketler sönümlenir (dönüş/yatay eğilim),
//     ALTINDA → hareketler hızlanır (trend/sert düşüş riski).
//   • Call duvarı: en büyük call GEX'li strike (direnç/mıknatıs) · Put duvarı: en büyük put GEX'li strike (destek).
// ⚠ Açık pozisyon günde 1 güncellenir; varsayım (yapıcı pozisyonu) her zaman doğru değildir → BİLGİ seviyesi, kural değil.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bs } from "../options/bs.mjs";
import { optionChain } from "../data/yahoo.mjs";

const CACHE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_gex.json");
const YR = 365 * 864e5;

// legs: [{ K, oi, iv, T, type }] → seviyeler (saf, test edilebilir)
export function gexLevels(legs, S, r = 0.04) {
  const ok = legs.filter(l => l.oi > 0 && l.iv > 0.01 && l.iv < 3 && l.T > 0);
  if (ok.length < 10 || !(S > 0)) return null;
  const g = (l, s) => bs(l.type, s, l.K, l.T, r, 0, l.iv).gamma * l.oi * 100 * s * s * 0.01 * (l.type === "C" ? 1 : -1);
  const byK = {};
  for (const l of ok) { const v = g(l, S); (byK[l.K] ||= { c: 0, p: 0 })[l.type === "C" ? "c" : "p"] += Math.abs(v); }
  // Call duvarı fiyatın üstündeki (direnç), put duvarı altındaki (destek) strike'lardan
  const ks = Object.keys(byK).map(Number), upK = ks.filter(k => k >= S * 0.995), dnK = ks.filter(k => k <= S * 1.005);
  const best = (list, f) => (list.length ? list.reduce((a, k) => (byK[k][f] > byK[a][f] ? k : a), list[0]) : null);
  const callWall = best(upK, "c"), putWall = best(dnK, "p");
  const net = s => ok.reduce((a, l) => a + g(l, s), 0);
  let flip = null, prev = null;
  for (let s = S * 0.92; s <= S * 1.08; s += S * 0.002) {
    const v = net(s);
    if (prev && Math.sign(prev.v) !== Math.sign(v)) { const x = prev.s + (s - prev.s) * (Math.abs(prev.v) / (Math.abs(prev.v) + Math.abs(v))); if (flip == null || Math.abs(x - S) < Math.abs(flip - S)) flip = x; }
    prev = { s, v };
  }
  return { S, callWall, putWall, flip: flip != null ? +flip.toFixed(2) : null, netNow: net(S) };
}

// Canlı: yakın 4 vade (≤ 35 gün), 30 dk önbellek (aynı makinedeki süreçler paylaşır)
export async function gexFor(sym, S, now = Date.now()) {
  let c = {};
  try { c = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}
  if (c[sym] && now - c[sym].at < 30 * 60e3) return c[sym].lv;
  const first = await optionChain(sym).catch(() => null);
  if (!first) return null;
  const exps = (first.expirations || []).filter(e => e * 1e3 + 20 * 3600e3 > now && e * 1e3 - now < 35 * 864e5).slice(0, 4);
  const legs = [];
  for (const e of exps) {
    const ch = e === first.exp ? first : await optionChain(sym, e).catch(() => null);
    if (!ch) continue;
    const T = Math.max(3600e3, e * 1e3 + 20 * 3600e3 - now) / YR;
    for (const o of ch.calls) if (Math.abs(o.strike / S - 1) < 0.08) legs.push({ K: o.strike, oi: o.oi, iv: o.yIV, T, type: "C" });
    for (const o of ch.puts) if (Math.abs(o.strike / S - 1) < 0.08) legs.push({ K: o.strike, oi: o.oi, iv: o.yIV, T, type: "P" });
  }
  const lv = gexLevels(legs, S);
  c[sym] = { at: now, lv };
  try { writeFileSync(CACHE, JSON.stringify(c)); } catch {}
  return lv;
}

export function fmtGex(lv) {
  if (!lv) return null;
  const above = lv.flip != null ? lv.S >= lv.flip : lv.netNow >= 0;
  return `  GEX: ${lv.flip != null ? `dönüş ${lv.flip.toFixed(0)} · ` : ""}call duvarı ${lv.callWall} · put duvarı ${lv.putWall} → ${above ? "fiyat üstte: hareket sönümlenir" : "fiyat altta: hareket hızlanabilir"}`;
}
