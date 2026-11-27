// CANLI KURULUM SEÇİMİ — research/intraday.mjs'in WALK-FORWARD ölçümünü (eğitim + örneklem dışı test) geçen kurulumlar
// (Gist: abd_setups.json) canlıda gönderilir. Kayıt: kurulum × yön × ufuk × gün parçası × gün tipi grubu.
// Liste yoksa / boşsa HİÇBİR kurulum gönderilmez. Ölçüm her hafta (ve liste eskiyince) kendiliğinden yenilenir.
import { loadUniverse } from "../spot/scan.mjs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { predLogit } from "./setups.mjs";

export const SETUPS_FILE = "abd_setups.json";
export const ALLOW_RULE = { N: 40, M: 0.15, T: 2 };
export const partOf = mins => (mins < 690 ? "sabah" : mins < 840 ? "öğle" : "öğleden sonra");
// Gün tipi → işlem yönüne göre grup: trend yönünde "lehte", trende karşı "aleyhte", "yatay", diğer "karışık"
export const dtGroup = (dt, dir) => (dt === "trend↑" ? (dir === "C" ? "lehte" : "aleyhte") : dt === "trend↓" ? (dir === "P" ? "lehte" : "aleyhte") : dt === "yatay" ? "yatay" : "karışık");

// Piyasa içi genişlik için S&P 500'ün en büyük 50 hissesi (dolar hacmine göre) — araştırma ve canlı AYNI liste
let _mem = null;
export function membersList() {
  if (_mem) return _mem;
  const U = loadUniverse();
  return (_mem = Object.entries(U.meta || {}).filter(([, m]) => m?.idx === "SP500" && m.dv > 0).sort((a, b) => b[1].dv - a[1].dv).slice(0, 50).map(([s]) => s));
}
export const MEMBERS = membersList();

// (Eski biçim, testlerde kullanılıyor) satırlar → izinli liste
export function buildAllow(rows, R = ALLOW_RULE) {
  const ok = s => s.n >= R.N && s.m >= R.M && s.t >= R.T, out = [];
  for (const r of rows || []) {
    if (!r.name || r.name === "ESKİ_SKOR") continue;
    if (ok(r)) out.push({ name: r.name, dir: r.dir, hor: r.hor, part: "tümü", dtg: "tümü", n: r.n, m: +r.m.toFixed(3), t: +r.t.toFixed(2) });
    else for (const [p, s] of Object.entries(r.part || {})) if (ok(s)) out.push({ name: r.name, dir: r.dir, hor: r.hor, part: p, dtg: "tümü", n: s.n, m: +s.m.toFixed(3), t: +s.t.toFixed(2) });
  }
  return out;
}

// Bu kurulum şu an gönderilebilir mi? (gün parçası ve gün tipi eşleşmeli) En iyi (en yüksek test ortalaması) | null
export function allowedFor(allow, name, dir, mins, dt = "erken") {
  const p = partOf(mins), g = dtGroup(dt, dir);
  return (allow || []).filter(a => a.name === name && a.dir === dir && (a.part === "tümü" || a.part === p) && (!a.dtg || a.dtg === "tümü" || a.dtg === g))
    .sort((a, b) => b.m - a.m)[0] || null;
}

// Model varsa ve kullanılıyorsa olasılık + eşik kararı. Dönüş: { p, ok }
export function modelCheck(model, x) {
  if (!model?.use || !model.w?.length || !x) return { p: null, ok: true };
  const p = predLogit(model.w, x);
  return { p, ok: model.thr == null || p >= model.thr };
}

export const SETUP_LABEL = {
  PULLBACK: { C: "trend içi geri çekilmeden dönüş", P: "düşüş trendinde tepkiden dönüş" },
  RECLAIM: { C: "VWAP geri alındı", P: "VWAP kaybedildi" },
  FLUSH: { C: "açılış düşüşü sindirildi", P: "açılış yükselişi silindi" },
  BREADTH: { C: "sektör genişliği yukarı döndü", P: "sektör genişliği aşağı döndü" },
  PDH: { C: "dünkü tepe kırıldı", P: "dünkü dip kırıldı" },
  GAP: { C: "aşağı boşluk kapandı (dünkü kapanış geri alındı)", P: "yukarı boşluk kapandı" },
  INTERNAL: { C: "büyük hisselerde genişlik yukarı döndü", P: "büyük hisselerde genişlik aşağı döndü" },
};

// Piyasa içi özet (ani hareket süreci her 5 dk yazar, 15 dk mesajı okur — aynı makine)
export const INTERNALS_FILE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_internals.json");
export function readInternals(now = Date.now(), maxAge = 12 * 60e3) {
  try { const o = JSON.parse(readFileSync(INTERNALS_FILE, "utf8")); return now - o.ts <= maxAge ? o : null; } catch { return null; }
}
export function fmtInternals(o) {
  if (!o) return null;
  const pc = x => (x == null ? "—" : "%" + Math.round(x * 100));
  const dt = { "trend↑": "trend günü ↑", "trend↓": "trend günü ↓", yatay: "yatay gün", karışık: "karışık gün", erken: "gün tipi 10:30'da belli olur" }[o.dt] || o.dt;
  return `📊 Piyasa içi: 50 büyük hissenin ${pc(o.mb)}'i VWAP üstünde${o.up ? ` · son 5 dk ${o.up.u}/${o.up.n} yükseldi` : ""} · sektörler ${pc(o.br)} · ${dt}`;
}
