// FİKİR KORUYUCU (ani hareket + ölçülmüş kurulum fikirleri; 15 dk / saatlik planlara dokunmaz). Saf fonksiyonlar, test edilebilir.
//  1) CANLI DURDURMA + SOĞUMA: bir fikir türünün (kurulum × yön, ani hareket türü × yön) canlı karnede ≥ 10 sonuçlanmış fikri varsa
//     ve SON 10'unun R toplamı negatifse, son fikrinden itibaren 30 gün gönderilmez. Sonra ×0.6 adetle yeniden denenir; yine
//     kaybettirirse tekrar durur. (Süresiz kilit olmaz: kapalı tür veri üretmez, bir kez kapanan asla açılmazdı.)
//  2) KANITA GÖRE ADET: canlı ortalama R, sıfıra doğru çekilir (Σr / (n + 10)) → küçük örnekte tek şanslı/şanssız fikir adedi
//     oynatmaz. ≥ +0.25 → ×1.3 · ≤ −0.15 → ×0.6 · arası (ya da < 5 fikir) → ×1.
//  3) AYNI YÖNE YIĞILMA: son 60 dk'da açılmış, henüz çıkmamış AYNI YÖNLÜ fikirler aynı kümedeyse (aynı sektör / endeks ETF'leri;
//     sektörü bilinmeyen sembolde 1 dk getiri korelasyonu ≥ 0.8) küme bütçesi uygulanır:
//       normal küme  : 1. fikir ×1 · 2. fikir ×0.5 · 3. fikir gönderilmez
//       LİDER sektör : 1. ×1 · 2. ×1 · 3. ×0.5 · 4. gönderilmez
//     Lider = sektör ETF'i gün içinde SPY'dan ≥ %0.5 iyi (PUT için ≥ %0.5 kötü), kendisi de o yönde ve 11 sektörün ilk 3'ünde
//     (PUT: son 3'ünde). Endeks kötüyken uçan sektör böylece birden fazla hisseyle oynanabilir; sıradan günde aynı risk iki kez alınmaz.
export const GUARD = { MIN_N: 10, LAST: 10, COOL_DAYS: 30, K: 10, HI: 0.25, LO: -0.15, TRIAL: 0.6, UP: 1.3, DOWN: 0.6,
  OPEN_MIN: 60, CORR: 0.8, LEAD_REL: 0.005, LEAD_TOP: 3, BUDGET: [1, 0.5], BUDGET_LEAD: [1, 1, 0.5] };

export const SECTOR_OF = {
  SPY: "MKT", QQQ: "MKT", IWM: "MKT", DIA: "MKT",
  NVDA: "XLK", AMD: "XLK", AVGO: "XLK", MU: "XLK", AAPL: "XLK", MSFT: "XLK", PLTR: "XLK", ORCL: "XLK", CRM: "XLK", INTC: "XLK", QCOM: "XLK", ADBE: "XLK",
  AMZN: "XLY", TSLA: "XLY", HD: "XLY", MCD: "XLY", NKE: "XLY",
  META: "XLC", GOOGL: "XLC", GOOG: "XLC", NFLX: "XLC", DIS: "XLC",
  COIN: "XLF", JPM: "XLF", BAC: "XLF", GS: "XLF", V: "XLF", MA: "XLF",
  XOM: "XLE", CVX: "XLE", LLY: "XLV", UNH: "XLV", JNJ: "XLV",
};

export const ideaKey = it => it.src === "setup" ? `setup|${it.setup}|${it.dir}` : it.src === "ta" || it.src === "wma" ? `${it.src}|${it.name}|${it.dir}` : `fast|${it.kind}|${it.dir}`;
export function keyLabel(key) {
  const [src, name, dir] = key.split("|"), d = dir === "C" ? "CALL" : "PUT";
  return src === "setup" ? `${name} ${d} kurulumu` : src === "ta" ? `${name} ${d} formasyonu` : src === "wma" ? `200 WMA ${name} ${d}` : `${name === "burst" ? "Ani hareket" : "Dönüş"} ${d} alarmı`;
}

// 1 + 2: fikir türünün canlı durumu → { n, avg, paused: { s10, daysLeft } | null, trial, mult, tag }
export function keyState(ideas, key, now = Date.now()) {
  const tsOf = x => x.ts ?? (x.d ? Date.parse(x.d + "T20:00:00Z") : NaN);       // günlük kayıtlarda yalnız tarih olabilir
  const done = (ideas || []).filter(i => i.res && i.res !== "geçersiz" && Number.isFinite(i.r) && ideaKey(i) === key).sort((a, b) => tsOf(a) - tsOf(b));
  const n = done.length, sum = done.reduce((a, i) => a + i.r, 0);
  let paused = null, trial = false;
  if (n >= GUARD.MIN_N) {
    const last = done.slice(-GUARD.LAST), s10 = last.reduce((a, i) => a + i.r, 0);
    if (s10 < 0) {
      const ago = (now - tsOf(last.at(-1))) / 864e5;
      if (ago < GUARD.COOL_DAYS) paused = { s10: +s10.toFixed(2), daysLeft: Math.max(1, Math.ceil(GUARD.COOL_DAYS - ago)) };
      else trial = true;
    }
  }
  const m = sum / (n + GUARD.K);
  const mult = paused ? 0 : trial ? GUARD.TRIAL : n < 5 ? 1 : m >= GUARD.HI ? GUARD.UP : m <= GUARD.LO ? GUARD.DOWN : 1;
  const tag = paused ? null : trial ? `deneme ×${GUARD.TRIAL}` : mult > 1 ? `karne iyi ×${mult}` : mult < 1 ? `karne zayıf ×${mult}` : null;
  return { n, avg: n ? sum / n : null, paused, trial, mult, tag };
}

// Şu an durdurulmuş türler: [{ key, s10, daysLeft }]
export function pausedList(ideas, now = Date.now()) {
  const keys = [...new Set((ideas || []).filter(i => i.res && (i.src === "setup" ? i.setup : i.src === "ta" || i.src === "wma" ? i.name : i.kind)).map(ideaKey))];
  return keys.map(key => ({ key, ...keyState(ideas, key, now).paused })).filter(x => x.s10 != null);
}

// Sektörler: 5 dk mumlar { SPY: [...], XLK: [...], ... } (bugünün seansı) → { ts, ret, rel }
export function computeLead(bars, now = Date.now()) {
  const r = a => (a?.length >= 2 && a[0].open > 0 ? a.at(-1).close / a[0].open - 1 : null);
  const spy = r(bars?.SPY);
  if (spy == null) return null;
  const ret = {}, rel = {};
  for (const [s, a] of Object.entries(bars)) {
    if (s === "SPY" || !/^XL[A-Z]{1,2}$/.test(s)) continue;
    const x = r(a); if (x != null) { ret[s] = x; rel[s] = x - spy; }
  }
  return Object.keys(rel).length >= 8 ? { ts: now, spy, ret, rel } : null;
}
export function isLeader(lead, sec, dir) {
  if (!lead || !sec || sec === "MKT" || lead.rel?.[sec] == null) return false;
  const order = Object.keys(lead.rel).sort((a, b) => lead.rel[b] - lead.rel[a]);
  const x = lead.rel[sec], y = lead.ret[sec];
  return dir === "C"
    ? x >= GUARD.LEAD_REL && y > 0 && order.indexOf(sec) < GUARD.LEAD_TOP
    : x <= -GUARD.LEAD_REL && y < 0 && order.indexOf(sec) >= order.length - GUARD.LEAD_TOP;
}

// 1 dk getirilerin korelasyonu (zaman damgasına göre eşlenir, son n mum)
export function corrRet(a, b, n = 60) {
  if (!a?.length || !b?.length) return 0;
  const mb = new Map(b.map(x => [x.ts, x.close])), xs = [], ys = [];
  for (let i = 1; i < a.length; i++) {
    const p0 = mb.get(a[i - 1].ts), p1 = mb.get(a[i].ts);
    if (p0 > 0 && p1 > 0 && a[i - 1].close > 0) { xs.push(a[i].close / a[i - 1].close - 1); ys.push(p1 / p0 - 1); }
  }
  const x = xs.slice(-n), y = ys.slice(-n), k = x.length;
  if (k < 20) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / k, my = y.reduce((s, v) => s + v, 0) / k;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < k; i++) { const u = x[i] - mx, w = y[i] - my; nu += u * w; dx += u * u; dy += w * w; }
  return dx && dy ? nu / Math.sqrt(dx * dy) : 0;
}

// 3: aynı kümedeki açık, aynı yönlü fikirler. open: [{ sym, dir, ts }] (zaten süzülmüş: son 60 dk, çıkmamış)
export function clusterMembers({ sym, dir }, open, corrOf = null) {
  const sec = SECTOR_OF[sym];
  return (open || []).filter(o => o.dir === dir && (o.sym === sym ||
    (sec && SECTOR_OF[o.sym] ? SECTOR_OF[o.sym] === sec : !!corrOf && corrOf(sym, o.sym) >= GUARD.CORR)));
}
export function clusterDecision(k, leader) {
  const b = leader ? GUARD.BUDGET_LEAD : GUARD.BUDGET;
  if (k >= b.length) return { ok: false, mult: 0 };
  return { ok: true, mult: b[k] };
}

// Hepsi bir arada (ani hareket + kurulum ortak). lead: computeLead çıktısı ya da null.
export function guardDecision(it, { ideas, open, lead = null, corrOf = null, now = Date.now() }) {
  const ks = keyState(ideas, ideaKey(it), now);
  if (ks.paused) return { ok: false, why: `${keyLabel(ideaKey(it))} durdurulmuş (son 10: ${ks.paused.s10}R, ${ks.paused.daysLeft} gün)` };
  const mem = clusterMembers(it, open, corrOf), leader = isLeader(lead, SECTOR_OF[it.sym], it.dir);
  const cd = clusterDecision(mem.length, leader);
  const names = [...new Set(mem.map(o => o.sym))].join(" ");
  if (!cd.ok) return { ok: false, why: `aynı yönde ${mem.length} açık fikir (${names})${leader ? " — lider sektörde bile sınır dolu" : ""}` };
  const tags = [ks.tag];
  if (mem.length) tags.push(`${leader ? "lider sektör" : "aynı küme"}: ${names} açık${cd.mult < 1 ? ` ×${cd.mult}` : ""}`);
  return { ok: true, mult: +(ks.mult * cd.mult).toFixed(2), tag: tags.filter(Boolean).join(" · ") || null, leader };
}
