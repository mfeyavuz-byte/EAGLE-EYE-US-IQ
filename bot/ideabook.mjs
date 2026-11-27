// CANLI KARNE — 15 dk SPY/QQQ fikirleri ve ani hareket alarmları: her fikir kaydedilir, ufku dolunca 1 dk mumlarla
// sonuçlandırılır: önce HEDEF mi STOP mu geldi (aynı mumda ikisi = STOP sayılır, ihtiyatlı); ikisi de yoksa ufuk sonundaki
// fiyatla R katı. R = |giriş − stop|. Sonuç dayanak hissede ölçülür (opsiyon primi değil; opsiyonda zaman kaybı ayrıca var).
// Her yazan süreç KENDİ Gist dosyasına yazar (çakışma yok); tarama (run.mjs) yalnız okur (haftalık rapor, /fikirkarne).
export const IDEA_FILES = { idx: "abd_ideas_idx.json", fast: "abd_ideas_fast.json" };
export const HORIZON = { idx: 60, fast: 30 };          // dk (kurulum fikirleri ufku ölçümden: 30/60)
const MAX = 600;

export function addIdea(book, idea) {
  (book.ideas ||= []).push({ ...idea, res: null });
  if (book.ideas.length > MAX) book.ideas.splice(0, book.ideas.length - MAX);
}

// Saf sonuçlandırma: bars = o sembolün 1 dk mumları (ts artan). now: ufuk dolmadıysa dokunma. Dönüş: değişti mi
export function settleOne(it, bars, now = Date.now()) {
  if (it.res || now < it.ts + it.hor * 60e3) return false;
  const end = it.ts + it.hor * 60e3, w = (bars || []).filter(b => b.ts >= it.ts && b.ts < end);
  const R = Math.abs(it.S - it.stop);
  if (!(R > 0)) { it.res = "geçersiz"; it.r = 0; return true; }
  const up = it.dir === "C";
  for (const b of w) {
    const hitS = up ? b.low <= it.stop : b.high >= it.stop, hitT = up ? b.high >= it.target : b.low <= it.target;
    if (hitS) { it.res = "STOP"; it.r = -1; return true; }
    if (hitT) { it.res = "HEDEF"; it.r = +(Math.abs(it.target - it.S) / R).toFixed(2); return true; }
  }
  if (!w.length && now - end < 3 * 864e5) return false;            // veri henüz yok → sonra tekrar dene (3 gün)
  const last = w.at(-1)?.close ?? it.S;
  it.res = "SÜRE"; it.r = +(((up ? 1 : -1) * (last - it.S)) / R).toFixed(2);
  return true;
}

// barsOf(sym) → 1 dk mumlar (≈ son 5 gün). Yalnız ufku dolmuş açık fikirlerin sembolleri çekilir.
export async function settleIdeas(book, barsOf, now = Date.now()) {
  const due = (book.ideas || []).filter(it => !it.res && now >= it.ts + it.hor * 60e3);
  if (!due.length) return false;
  let changed = false;
  const cache = {};
  for (const it of due) {
    cache[it.sym] ??= await barsOf(it.sym).catch(() => null);
    if (cache[it.sym] && settleOne(it, cache[it.sym], now)) changed = true;
  }
  return changed;
}

export function ideaStats(ideas, fromTs = 0, toTs = Infinity) {
  const done = (ideas || []).filter(it => it.res && it.res !== "geçersiz" && it.ts >= fromTs && it.ts < toTs);
  const k = x => done.filter(it => it.res === x).length;
  return { n: done.length, hit: k("HEDEF"), stop: k("STOP"), time: k("SÜRE"), avgR: done.length ? done.reduce((a, it) => a + it.r, 0) / done.length : null,
    open: (ideas || []).filter(it => !it.res && it.ts >= fromTs && it.ts < toTs).length };
}

export function fmtIdeaStats(title, s) {
  if (!s.n) return `${title}: henüz sonuçlanan fikir yok${s.open ? ` (${s.open} açık)` : ""}.`;
  return `${title}: ${s.n} fikir · 🎯 hedef ${s.hit} · 🛑 stop ${s.stop} · ⏱ süre ${s.time} · isabet %${Math.round(s.hit / s.n * 100)} · ` +
    `ort. ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R${s.open ? ` · açık ${s.open}` : ""}`;
}

// Rapor bloğu (haftalık rapor, /fikirkarne): iki kaynak × (son 7 gün, son 30 gün)
export function fmtIdeaReport(books, now = Date.now()) {
  const d7 = now - 7 * 864e5, d30 = now - 30 * 864e5, L = ["📒 GÜN İÇİ FİKİR KARNESİ (dayanakta ölçülür; 1R = girişten stop'a mesafe)"];
  for (const [k, lab, src] of [["fast", "⚡ Ani hareket", "fast"], ["fast", "🎯 Ölçülmüş kurulumlar", "setup"]]) {   // 15 dk artık plan (fikir kaydı yok)
    const ideas = (books?.[k]?.ideas || []).filter(it => !src || (it.src || "fast") === src);
    L.push(fmtIdeaStats(`${lab} · 7 gün`, ideaStats(ideas, d7)), fmtIdeaStats(`${lab} · 30 gün`, ideaStats(ideas, d30)));
  }
  L.push("ℹ Başabaş: 1:2 risk/ödülde isabet ≥ %34 ve ortalama > 0R olmalı. Opsiyonda zaman kaybı ve spread bu sonucu düşürür.");
  return L.join("\n");
}
