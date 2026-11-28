// TEKNİK ANALİZ MOTORU (günlük mum, saf fonksiyonlar — araştırma ve canlı AYNI kod, ileriye bakma yok).
// Dönüş noktaları: ATR tabanlı zigzag; her dönüş ancak fiyat karşı yöne ZZ_K × ATR gidince "teyit" edilir (c = teyit mumu).
// Bir sinyal yalnız teyit mumunda üretilir → o gün bilinmeyen hiçbir şey kullanılmaz.
// Trend KISA VADEDEN ölçülür (kullanıcı isteği; 200 gün / 6 ay gibi uzun ölçüler yok): EMA20 > EMA50, EMA20 yükseliyor,
// son iki dip yükselen (düşüşte tersi).
// ELLIOTT (NEoWave kuralları — Glenn Neely; Uğur Perçin "Neowave – Elliott Dalga Teorisi" eğitim listesinin konusu):
//   • 2. dalga 1. dalganın %100'ünü geri alamaz (burada %38.2–78.6) · komşu dalgalar fiyatta birbirinin ≥ 1/3'ü (benzerlik)
//   • 3. dalga en kısa olamaz (≥ 1. dalga) · 4. dalga 1. dalganın tepesine girmez (örtüşme yok) · 4. dalga 3'ün %25–61.8'i
//   • 3. dalga uzamışsa (≥ 1.618 × 1. dalga) 5. dalga ≈ 1. dalga · ABC: C ≈ A (0.618–1.618), B, A'nın %38.2–88.6'sı
// Kaynak müfredat: Uğur Perçin "Neowave – Elliott Dalga Teorisi" (itki, zikzak, flat, üçgenler) + Jamiryo "Elliott Dalgaları
// Eğitim Serisi" (itki, zikzak, flat, diyagonaller, WXY) — videolardaki standart kurallar:
//   • Zikzak (5-3-5): B, A'nın %38.2–88.6'sı · C ≈ A (0.618–1.618)
//   • Flat (3-3-5): B, A'nın ≥ %81'i (genişleyen flat'te %100–138) · C, A'nın %100–165'i (A'nın bitişini geçer)
//   • Daralan üçgen (a-b-c-d-e): tepeler alçalır, dipler yükselir, dalgalar küçülür → e'den sonra itki ≈ a dalgası boyu
//   • Bitiş diyagonali (kama): 5 dalga daralarak aynı yöne, 4. dalga 1.'nin alanına girer (örtüşme) → başlangıca dönüş
// Sinyaller (yön: C = yükseliş → CALL al, P = düşüş → PUT al; opsiyon SATIŞI yok):
//   EW2  2. dalga bitti → 3. dalga başlıyor        EW4  4. dalga bitti → 5. dalga
//   ABC  trend içi ABC düzeltmesi bitti            TLB  düşen trend çizgisi hacimle kırıldı (P: yükselen çizgi aşağı)
//   DIP  dipten dönüş: daha düşük dip + RSI pozitif uyumsuzluk (P: tepeden dönüş, negatif uyumsuzluk)
// 200 HAFTALIK ORTALAMA (haftalık kapanış): UP yukarı kırdı · DN aşağı kırdı · TOUCH yükselişte ortalamaya geldi (destek)
//   · RETEST kırılım sonrası geri test tuttu.
export const TA = { ZZ_K: 2, ATR_N: 14, MIN_W: 3, HOR: 20, TLB_LOOK: 120, TLB_VOL: 1.2, DIP_DROP: 3,
  WMA_N: 200, WMA_SIDE: 8, WMA_NEAR: 0.02, WMA_RETEST_WK: 12, NAMES: ["EW2", "EW4", "ABC", "FLAT", "TRI", "DIAG", "TLB", "DIP", "MA20"] };
export const TA_FILE = "abd_ta.json";
export const TA_LABEL = {
  EW2: { C: "Elliott: 2. dalga bitti → 3. dalga başlıyor", P: "Elliott: düşüşte 2. dalga bitti → 3. dalga aşağı" },
  EW4: { C: "Elliott: 4. dalga bitti → 5. dalga yukarı", P: "Elliott: düşüşte 4. dalga bitti → 5. dalga aşağı" },
  ABC: { C: "Elliott: zikzak (ABC) düzeltme bitti, trend devam", P: "Elliott: zikzak (ABC) tepki bitti, düşüş devam" },
  TLB: { C: "Düşen trend çizgisi hacimle kırıldı", P: "Yükselen trend çizgisi aşağı kırıldı" },
  DIP: { C: "Dipten dönüş (RSI pozitif uyumsuzluk)", P: "Tepeden dönüş (RSI negatif uyumsuzluk)" },
  MA20: { C: "Yükselen trendde 20 günlük ortalamaya geri çekilme", P: "Düşen trendde 20 günlük ortalamaya tepki" },
  FLAT: { C: "Elliott: yassı (flat) düzeltme bitti, trend devam", P: "Elliott: yassı (flat) tepki bitti, düşüş devam" },
  TRI: { C: "Elliott: daralan üçgen bitti → yukarı itki", P: "Elliott: daralan üçgen bitti → aşağı itki" },
  DIAG: { C: "Elliott: bitiş diyagonali (düşen kama) → dipten dönüş", P: "Elliott: bitiş diyagonali (yükselen kama) → tepeden dönüş" },
};

const emaArr = (c, n) => { const o = new Array(c.length).fill(null), k = 2 / (n + 1); let e = null;
  for (let i = 0; i < c.length; i++) { e = e == null ? c[i] : c[i] * k + e * (1 - k); if (i >= n - 1) o[i] = e; } return o; };
function atrArr(r, n = TA.ATR_N) {
  const o = new Array(r.length).fill(null); let a = null;
  for (let i = 1; i < r.length; i++) {
    const t = Math.max(r[i].high - r[i].low, Math.abs(r[i].high - r[i - 1].close), Math.abs(r[i].low - r[i - 1].close));
    a = a == null ? t : (a * (n - 1) + t) / n; if (i >= n) o[i] = a;
  }
  return o;
}
function rsiArr(c, n = 14) {
  const o = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), v = Math.max(-d, 0);
    if (i <= n) { g += u / n; l += v / n; } else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + v) / n; }
    if (i >= n) o[i] = l ? 100 - 100 / (1 + g / l) : 100;
  }
  return o;
}
// ATR zigzag: [{ i: dönüş mumu, c: teyit mumu, p: fiyat, t: "H" | "L" }]
export function zigzag(r, atr, k = TA.ZZ_K) {
  const out = []; let dir = 0, hiI = 0, loI = 0, ei = 0;
  const argExt = (from, to, hi) => { let j = from; for (let q = from; q <= to; q++) if (hi ? r[q].high > r[j].high : r[q].low < r[j].low) j = q; return j; };
  for (let i = 1; i < r.length; i++) {
    const a = atr[i];
    if (dir === 0) {                                                       // ilk anlamlı hareketin yönü
      if (r[i].high > r[hiI].high) hiI = i;
      if (r[i].low < r[loI].low) loI = i;
      if (!(a > 0)) continue;
      if (hiI < i && r[hiI].high - r[i].low >= k * a) { out.push({ i: hiI, c: i, p: r[hiI].high, t: "H" }); dir = -1; ei = argExt(hiI + 1, i, false); }
      else if (loI < i && r[i].high - r[loI].low >= k * a) { out.push({ i: loI, c: i, p: r[loI].low, t: "L" }); dir = 1; ei = argExt(loI + 1, i, true); }
      continue;
    }
    if (dir === 1) {
      if (r[i].high > r[ei].high) ei = i;
      else if (a > 0 && r[ei].high - r[i].low >= k * a) { out.push({ i: ei, c: i, p: r[ei].high, t: "H" }); dir = -1; ei = argExt(ei + 1, i, false); }
    } else {
      if (r[i].low < r[ei].low) ei = i;
      else if (a > 0 && r[i].high - r[ei].low >= k * a) { out.push({ i: ei, c: i, p: r[ei].low, t: "L" }); dir = 1; ei = argExt(ei + 1, i, true); }
    }
  }
  return out;
}

export function prep(rows) {
  const c = rows.map(r => r.close), atr = atrArr(rows);
  const vol20 = rows.map((_, i) => (i >= 20 ? rows.slice(i - 20, i).reduce((a, r) => a + (r.volume || 0), 0) / 20 : null));
  const sma20 = c.map((_, i) => (i >= 19 ? c.slice(i - 19, i + 1).reduce((a, x) => a + x, 0) / 20 : null));
  return { c, atr, sma20, ema20: emaArr(c, 20), ema50: emaArr(c, 50), rsi: rsiArr(c), vol20, piv: zigzag(rows, atr) };
}
// Kısa vadeli trend (uzun ölçü YOK): +1 yükseliş, −1 düşüş, 0 belirsiz
export function shortTrend(P, i, known) {
  const e20 = P.ema20[i], e50 = P.ema50[i], e20p = P.ema20[i - 5];
  if (!(e20 && e50 && e20p)) return 0;
  const L = known.filter(p => p.t === "L").slice(-2), H = known.filter(p => p.t === "H").slice(-2);
  const hl = L.length === 2 && L[1].p > L[0].p, lh = H.length === 2 && H[1].p < H[0].p;
  if (e20 > e50 && e20 > e20p && hl) return 1;
  if (e20 < e50 && e20 < e20p && lh) return -1;
  return 0;
}

const mk = (name, dir, S, stop, target, why) => ({ name, dir, S, stop: +stop.toFixed(2), target: +target.toFixed(2), why });
// i. günün sinyalleri (yalnız i'de teyit edilen dönüşlerle tetiklenir; TLB fiyat kesişimiyle)
export function taSignals(rows, P, i) {
  const out = [], a = P.atr[i], S = rows[i].close;
  if (!(a > 0) || i < 60) return out;
  const known = P.piv.filter(p => p.c <= i), last = known.at(-1), fresh = last?.c === i;
  const tr = shortTrend(P, i, known);
  for (const s of [1, -1]) {                                              // s = +1: yükseliş kalıbı (CALL), −1: aynalanmış (PUT)
    const dir = s === 1 ? "C" : "P", lowT = s === 1 ? "L" : "H", v = p => s * p.p;      // aynalı fiyat: düşüşte işaret çevrilir
    if (fresh && last.t === lowT) {
      const k = known;
      // EW2: [L0, H1, L2]
      if (k.length >= 3) {
        const [L0, H1, L2] = k.slice(-3), w1 = v(H1) - v(L0), r2 = (v(H1) - v(L2)) / w1;
        if (w1 >= TA.MIN_W * a && r2 >= 0.382 && r2 <= 0.786 && v(L2) > v(L0))
          out.push(mk("EW2", dir, S, L2.p - s * 0.25 * a, L2.p + s * 1.618 * w1, `1. dalga ${(w1 / a).toFixed(1)} ATR · 2. dalga %${Math.round(r2 * 100)} geri aldı`));
      }
      // EW4: [L0, H1, L2, H3, L4]
      if (k.length >= 5) {
        const [L0, H1, L2, H3, L4] = k.slice(-5), w1 = v(H1) - v(L0), w3 = v(H3) - v(L2), r4 = (v(H3) - v(L4)) / w3;
        if (w1 >= TA.MIN_W * a && v(L2) > v(L0) && v(H3) > v(H1) && w3 >= w1 && v(L4) > v(H1) && r4 >= 0.25 && r4 <= 0.618 && (v(H1) - v(L2)) >= w1 / 3)
          out.push(mk("EW4", dir, S, L4.p - s * 0.5 * a, L4.p + s * w1, `3. dalga ${(w3 / w1).toFixed(2)}× 1. dalga${w3 >= 1.618 * w1 ? " (uzamış → 5 ≈ 1)" : ""} · 4. dalga %${Math.round(r4 * 100)}`));
      }
      // ABC: [H0, La, Hb, Lc] — öncesinde kısa vadeli trend o yönde olmalı (A'nın tepesinde EMA20 > EMA50)
      if (k.length >= 4) {
        const [H0, La, Hb, Lc] = k.slice(-4), A = v(H0) - v(La), C = v(Hb) - v(Lc), rb = (v(Hb) - v(La)) / A;
        const pre = s * ((P.ema20[H0.i] ?? 0) - (P.ema50[H0.i] ?? 0)) > 0;
        if (A >= TA.MIN_W * a && v(Hb) < v(H0) && v(Lc) < v(La) && C / A >= 0.618 && C / A <= 1.618 && rb >= 0.382 && rb <= 0.886 && pre)
          out.push(mk("ABC", dir, S, Lc.p - s * 0.5 * a, H0.p, `C = ${(C / A).toFixed(2)}× A · B %${Math.round(rb * 100)}`));
      }
      // FLAT: [H0, La, Hb, Lc] — B neredeyse A'nın tamamını (≥ %81, ≤ %138) geri alır, C ≥ A (A'nın dibini geçer)
      if (k.length >= 4) {
        const [H0, La, Hb, Lc] = k.slice(-4), A = v(H0) - v(La), C = v(Hb) - v(Lc), rb = (v(Hb) - v(La)) / A;
        const pre = s * ((P.ema20[H0.i] ?? 0) - (P.ema50[H0.i] ?? 0)) > 0;
        if (A >= TA.MIN_W * a && rb >= 0.81 && rb <= 1.38 && C / A >= 1 && C / A <= 1.65 && pre)
          out.push(mk("FLAT", dir, S, Lc.p - s * 0.5 * a, Math.max(s * H0.p, s * Hb.p) * s, `B %${Math.round(rb * 100)} · C = ${(C / A).toFixed(2)}× A`));
      }
      // TRI: [X0..X5] daralan üçgen; X5 = e dibi (CALL için). Öncesinde trend o yönde → itki ≈ a boyu
      if (k.length >= 6) {
        const X = k.slice(-6), h = [X[0], X[2], X[4]].map(v), l = [X[1], X[3], X[5]].map(v);
        const legs = [0, 1, 2, 3, 4].map(q => Math.abs(X[q + 1].p - X[q].p)), pre = s * ((P.ema20[X[0].i] ?? 0) - (P.ema50[X[0].i] ?? 0)) > 0;
        if (h[0] > h[1] && h[1] > h[2] && l[0] < l[1] && l[1] < l[2] && legs[0] > legs[2] && legs[2] > legs[4] && legs[0] >= TA.MIN_W * a && pre)
          out.push(mk("TRI", dir, S, X[5].p - s * 0.5 * a, X[5].p + s * legs[0], `a ${(legs[0] / a).toFixed(1)} ATR → e ${(legs[4] / a).toFixed(1)} ATR`));
      }
      // DIAG: [X0..X5] düşen kama (CALL): tepeler ve dipler alçalır, dalgalar küçülür, 4. dalga 1.'nin alanına girer → X0'a dönüş
      if (k.length >= 6) {
        const X = k.slice(-6), legs = [0, 1, 2, 3, 4].map(q => Math.abs(X[q + 1].p - X[q].p));
        const fall = v(X[0]) > v(X[2]) && v(X[2]) > v(X[4]) && v(X[1]) > v(X[3]) && v(X[3]) > v(X[5]);
        if (fall && v(X[4]) > v(X[1]) && legs[0] > legs[2] && legs[2] > legs[4] && legs[0] >= TA.MIN_W * a)
          out.push(mk("DIAG", dir, S, X[5].p - s * 0.5 * a, X[0].p, `5 dalga daralan kama · örtüşme var`));
      }
      // DIP: [Lp, H, L] — daha düşük dip + RSI uyumsuzluğu + öncesinde ≥ 3 ATR düşüş
      if (k.length >= 3) {
        const [Lp, H, L] = k.slice(-3), rL = P.rsi[L.i], rP = P.rsi[Lp.i];
        if (v(L) < v(Lp) && rL != null && rP != null && s * (rL - rP) >= 3 && (s === 1 ? rL < 40 : rL > 60) && v(H) - v(L) >= TA.DIP_DROP * a)
          out.push(mk("DIP", dir, S, L.p - s * 0.25 * a, H.p, `RSI ${Math.round(rP)} → ${Math.round(rL)} (fiyat daha ${s === 1 ? "düşük dip" : "yüksek tepe"})`));
      }
    }
    // MA20: kısa vadeli trend o yönde, fiyat 5 gündür ortalamanın o tarafında, bugün ortalamaya değdi ve o tarafta kapattı (ilk temas)
    const m20 = P.sma20[i];
    if (m20 && tr === s && i >= 6) {
      const touch = s === 1 ? rows[i].low <= m20 * 1.005 && S > m20 : rows[i].high >= m20 * 0.995 && S < m20;
      const away = [1, 2, 3, 4, 5].every(q => P.sma20[i - q] && s * (rows[i - q].close - P.sma20[i - q]) > 0 && s * ((s === 1 ? rows[i - q].low : rows[i - q].high) - P.sma20[i - q] * (1 + s * 0.005)) > 0);
      if (touch && away) {
        const stop = (s === 1 ? Math.min(rows[i].low, m20) : Math.max(rows[i].high, m20)) - s * 0.5 * a, R = Math.abs(S - stop);
        if (R > 0) out.push(mk("MA20", dir, S, stop, S + s * 2 * R, `ortalama ${m20.toFixed(2)}`));
      }
    }
    // TLB: son iki teyitli tepe (düşen) çizgisi, kapanış yukarı kesti + hacim
    const highT = s === 1 ? "H" : "L", hs = known.filter(p => p.t === highT && p.i >= i - TA.TLB_LOOK).slice(-2);
    if (hs.length === 2 && v(hs[1]) < v(hs[0]) && i > hs[1].c) {
      const line = j => hs[0].p + (hs[1].p - hs[0].p) * (j - hs[0].i) / (hs[1].i - hs[0].i);
      const crossed = s * (rows[i].close - line(i)) > 0 && s * (rows[i - 1].close - line(i - 1)) <= 0;
      if (crossed && P.vol20[i] > 0 && (rows[i].volume || 0) >= TA.TLB_VOL * P.vol20[i]) {
        const ext = s === 1 ? Math.min(...rows.slice(i - 4, i + 1).map(x => x.low)) : Math.max(...rows.slice(i - 4, i + 1).map(x => x.high));
        const stop = ext - s * 0.25 * a, R = Math.abs(S - stop);
        if (R > 0) out.push(mk("TLB", dir, S, stop, S + s * 2 * R, `çizgi ${line(i).toFixed(2)} · hacim ${((rows[i].volume || 0) / P.vol20[i]).toFixed(1)}×`));
      }
    }
  }
  return out.map(x => ({ ...x, trend: tr }));
}

// R sonucu: önce stop mu hedef mi (aynı mumda ikisi = stop), yoksa ufuk sonu
export function taOutcome(rows, i, sg, hor = TA.HOR) {
  const R = Math.abs(sg.S - sg.stop), up = sg.dir === "C";
  if (!(R > 0)) return 0;
  for (let k = i + 1; k <= Math.min(rows.length - 1, i + hor); k++) {
    const x = rows[k], hs = up ? x.low <= sg.stop : x.high >= sg.stop, ht = up ? x.high >= sg.target : x.low <= sg.target;
    if (hs) return -1;
    if (ht) return Math.abs(sg.target - sg.S) / R;
  }
  const last = rows[Math.min(rows.length - 1, i + hor)].close;
  return ((up ? 1 : -1) * (last - sg.S)) / R;
}

// 200 HAFTALIK ORTALAMA — w: haftalık mumlar (son mum = bu hafta / son tamamlanan). j: değerlendirilen hafta
export function wmaArr(w, n = TA.WMA_N) {
  const o = new Array(w.length).fill(null); let s = 0;
  for (let i = 0; i < w.length; i++) { s += w[i].close; if (i >= n) s -= w[i - n].close; if (i >= n - 1) o[i] = s / n; }
  return o;
}
export function wmaEvent(w, m, j) {
  const x = m[j], c = w[j]?.close, N = TA.WMA_SIDE;
  if (!(x > 0) || j < N + 1 || m[j - N] == null) return null;
  const side = k => (w[k].close > m[k] ? 1 : -1), d = c / x - 1;
  let run = 0; for (let k = j - 1; k >= 0 && m[k] != null && side(k) === side(j - 1); k--) run++;    // önceki haftaların aynı tarafta kalma süresi
  if (c > x && side(j - 1) < 0 && run >= N) return { ev: "UP", dir: "C", wma: x, d };
  if (c < x && side(j - 1) > 0 && run >= N) return { ev: "DN", dir: "P", wma: x, d };
  // Ortalamaya İLK geliş (önceki hafta %2 bandının dışındaydı), kapanış hâlâ üstte
  const near = w[j].low <= x * (1 + TA.WMA_NEAR), wasFar = w[j - 1].low > m[j - 1] * (1 + TA.WMA_NEAR);
  if (c > x && near && wasFar && side(j - 1) > 0) {
    let k = j - 1; while (k > 0 && m[k] != null && side(k) > 0) k--;
    const weeksAbove = j - 1 - k, crossedRecently = m[k] != null && side(k) < 0 && weeksAbove <= TA.WMA_RETEST_WK;
    if (crossedRecently) return { ev: "RETEST", dir: "C", wma: x, d };
    if (weeksAbove >= 26) return { ev: "TOUCH", dir: "C", wma: x, d };
  }
  return null;
}
export const WMA_LABEL = { UP: "200 haftalık ortalamayı YUKARI kırdı", DN: "200 haftalık ortalamayı AŞAĞI kırdı", TOUCH: "200 haftalık ortalamaya geldi (destek)", RETEST: "kırılım sonrası 200 haftalık ortalamayı geri test etti, tuttu" };

// ---- Mesajlar (sade: varlık, yön, giriş, hedef, stop, kontrat, test sonucu) ----
const f2 = x => (x >= 100 ? x.toFixed(1) : x.toFixed(2));
const pc = x => `${x >= 0 ? "+" : "−"}%${Math.abs(x * 100).toFixed(1)}`;
export function fmtTa(list) {
  if (!list?.length) return null;
  return ["📐 TEKNİK FORMASYONLAR", ...list.map(x => `${x.dir === "C" ? "🟢" : "🔴"} ${x.sym} ${x.dir === "C" ? "CALL" : "PUT"} AL — ${TA_LABEL[x.name][x.dir]}${TF_LABEL[x.a?.tf] || ""}\n` +
    `   Giriş ~${f2(x.S)} · Hedef ${f2(x.target)} · Stop ${f2(x.stop)}${x.contract ? ` · ${x.contract}` : ""}`)].join("\n");
}
export function fmtWma(list, stats) {
  if (!list?.length) return null;
  const ico = { UP: "🟢", DN: "🔴", TOUCH: "🟡", RETEST: "🟢" };
  return ["📏 200 HAFTALIK ORTALAMA", ...list.map(x => {
    const s = stats?.[x.ev], chase = x.ev === "UP" && x.d >= 0.05, act = chase ? "BEKLE (kovalama)" : x.dir === "C" ? "CALL AL" : "PUT AL";
    const stop = x.dir === "C" ? `stop: haftalık kapanış ${f2(x.wma * 0.97)} altı` : `stop: haftalık kapanış ${f2(x.wma * 1.03)} üstü`;
    return `${chase ? "🟡" : ico[x.ev]} ${x.sym} ${act} — ${WMA_LABEL[x.ev]}${chase ? " ama %5'ten fazla uzakta → geri çekilmede al" : ""}\n   Fiyat ~${f2(x.px)} · ortalama ${f2(x.wma)} (${pc(x.d)}) · ${stop}${x.contract ? ` · ${x.contract}` : ""}` +
      (s?.n && !(s.x13 > 0) ? " · ⚠ zayıf sinyal, küçük tut" : "");
  })].join("\n");
}

// ---- KESİŞİM: formasyon + momentum lideri (6 ay SPY'dan güçlü, MA50 > MA200) + lider sektör (20 gün SPY'dan iyi, ilk 3) ----
// tf: "tümü" | "trendle" | "mom" | "lider" | "ikisi" — araştırma hangisi geçtiyse canlı aynı şartı arar
export const TF_LABEL = { tümü: "", trendle: " (kısa vadeli trend yönünde)", mom: " + momentum lideri", lider: " + lider sektörde", ikisi: " + momentum lideri + lider sektörde" };
export function tfMatch(tf, sg, fl = {}) {
  if (tf === "tümü") return true;
  if (tf === "trendle") return sg.trend === (sg.dir === "C" ? 1 : -1);
  if (tf === "mom") return !!fl.mom;
  if (tf === "lider") return !!fl.lead;
  if (tf === "ikisi") return !!(fl.mom && fl.lead);
  return false;
}
// Sektör 20 günlük liderlik: closes = { SPY: [...], XLK: [...] } (aynı tarih hizasında son değerler) → { XLK: true, ... }
export function sectorLead20(last) {
  const spy = last.SPY; if (!(spy > -1)) return {};
  const rel = Object.entries(last).filter(([k, v]) => k !== "SPY" && v != null).map(([k, v]) => [k, v - spy]).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(rel.map(([k, v], q) => [k, q < 3 && v > 0]));
}

// ---- CANLI KARNE (formasyon + 200 WMA) — gönderilen her fikir kaydedilir, günlük mumlarla sonuçlandırılır ----
// Formasyon: stop/hedef/20 işlem günü (aynı mumda ikisi = stop) → R. 200 WMA: 65 işlem günü (≈ 13 hafta) ya da günlük kapanış
// stopu geçerse; sonuç yön yönünde % getiri (r = getiri / stop mesafesi → R).
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
export function settleTa(rec, rows, today) {
  if (rec.res) return false;
  const j = rows.findIndex(r => dayOf(r.ts) === rec.d);
  if (j < 0) return false;
  const up = rec.dir === "C", R = Math.abs(rec.S - rec.stop), hor = rec.src === "wma" ? 65 : TA.HOR;
  if (!(R > 0)) { rec.res = "geçersiz"; rec.r = 0; return true; }
  for (let k = j + 1; k < rows.length && k <= j + hor; k++) {
    if (dayOf(rows[k].ts) >= today) break;                                  // bugünün mumu tamamlanmadı
    const x = rows[k];
    if (rec.src === "wma") {
      if (up ? x.close <= rec.stop : x.close >= rec.stop) { rec.res = "STOP"; rec.r = +(((up ? 1 : -1) * (x.close - rec.S)) / R).toFixed(2); rec.end = dayOf(x.ts); return true; }
      if (k === j + hor) { rec.res = "SÜRE"; rec.r = +(((up ? 1 : -1) * (x.close - rec.S)) / R).toFixed(2); rec.end = dayOf(x.ts); return true; }
      continue;
    }
    const hs = up ? x.low <= rec.stop : x.high >= rec.stop, ht = up ? x.high >= rec.target : x.low <= rec.target;
    if (hs) { rec.res = "STOP"; rec.r = -1; rec.end = dayOf(x.ts); return true; }
    if (ht) { rec.res = "HEDEF"; rec.r = +(Math.abs(rec.target - rec.S) / R).toFixed(2); rec.end = dayOf(x.ts); return true; }
    if (k === j + hor) { rec.res = "SÜRE"; rec.r = +(((up ? 1 : -1) * (x.close - rec.S)) / R).toFixed(2); rec.end = dayOf(x.ts); return true; }
  }
  return false;
}
export function fmtTaBook(book) {
  const L = ["📐 FORMASYON + 200 WMA CANLI KARNE (1R = girişten stop'a)"], by = {};
  for (const b of book || []) { const k = b.src === "wma" ? `200 WMA ${b.name}` : `${b.name} ${b.dir === "C" ? "CALL" : "PUT"}`; (by[k] ||= []).push(b); }
  if (!Object.keys(by).length) return L[0] + "\nHenüz gönderilmiş fikir yok.";
  for (const [k, a] of Object.entries(by)) {
    const d = a.filter(x => x.res && x.res !== "geçersiz"), open = a.length - d.length - a.filter(x => x.res === "geçersiz").length;
    const avg = d.length ? d.reduce((p, x) => p + x.r, 0) / d.length : null;
    L.push(`${k}: ${d.length ? `${d.length} sonuçlandı · isabet %${Math.round(d.filter(x => x.r > 0).length / d.length * 100)} · ort ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}R` : "henüz sonuç yok"}${open ? ` · açık ${open}` : ""}`);
  }
  return L.join("\n");
}
