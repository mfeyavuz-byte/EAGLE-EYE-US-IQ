// HABER DUYGUSU — İngilizce finans başlıkları için sözlük tabanlı puan (−1 … +1). Bağımlılıksız, deterministik.
// Kullanım: (1) canlı AL/SAT mesajlarında yalnız BİLGİ etiketi (kurala girmez); (2) research/news.mjs ile geçmişte
// "olumlu/olumsuz başlık sonrası getiri" ölçülür — anlamlı bir fark çıkarsa kurala eklenir.
const POS = ["beat", "beats", "tops", "topped", "exceeds", "surpass", "raises", "raised", "hikes", "boost", "boosts", "upgrade",
  "upgraded", "outperform", "overweight", "buy rating", "record", "surge", "surges", "soar", "soars", "jump", "jumps", "rally",
  "rallies", "gain", "gains", "approval", "approved", "approves", "wins", "won", "awarded", "contract", "partnership", "deal",
  "buyback", "repurchase", "dividend increase", "strong", "robust", "accelerat", "expands", "expansion", "breakthrough", "bullish", "upbeat", "optimis"];
const NEG = ["miss", "misses", "missed", "falls short", "cut", "cuts", "lowers", "lowered", "slash", "downgrade", "downgraded",
  "underperform", "underweight", "sell rating", "plunge", "plunges", "tumble", "tumbles", "sink", "sinks", "drop", "drops", "fall",
  "falls", "slump", "lawsuit", "sued", "probe", "investigation", "subpoena", "recall", "delay", "delayed", "warning", "warns",
  "weak", "weaker", "layoff", "layoffs", "resign", "resigns", "fraud", "charges", "bankrupt", "default", "halt", "halted", "bearish",
  "downbeat", "concern", "fears", "loss", "losses", "decline", "declines"];
const NEGATE = /\b(no|not|without|despite|fails to|failed to)\b/;

const hits = (h, words) => words.reduce((a, w) => a + (new RegExp(`\\b${w}`, "i").test(h) ? 1 : 0), 0);

// Tek başlık puanı: (olumlu − olumsuz) / (olumlu + olumsuz), olumsuzlama (not/no/despite) işareti çevirir. Eşleşme yoksa 0.
export function headlineScore(h) {
  const t = String(h || "").toLowerCase();
  const p = hits(t, POS), n = hits(t, NEG);
  if (!p && !n) return 0;
  const s = (p - n) / (p + n);
  return NEGATE.test(t) ? -s * 0.5 : s;
}

// Başlık listesi → { score (ortalama, yalnız eşleşenler), n (eşleşen), total } | null
export function newsSentiment(items, sinceMs = 0) {
  const xs = (items || []).filter(x => !sinceMs || Date.parse(x.t) >= sinceMs).map(x => headlineScore(x.headline)).filter(s => s !== 0);
  if (!xs.length) return null;
  return { score: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
}

// Mesaj etiketi: |puan| ≥ 0.25 ve en az 2 eşleşen başlık
export function newsTag(sent) {
  if (!sent || sent.n < 2 || Math.abs(sent.score) < 0.25) return null;
  return `📰 haber ${sent.score > 0 ? "olumlu" : "olumsuz"} (${sent.score > 0 ? "+" : ""}${sent.score.toFixed(2)}, ${sent.n} başlık · bilgi)`;
}
