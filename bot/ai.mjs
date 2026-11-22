// YAPAY ZEKÂ YORUM KATMANI (isteğe bağlı) — Claude API ile her sinyale 2-3 cümlelik Türkçe yorum.
// Açmak: repo secret ANTHROPIC_API_KEY. Kapatmak: AI_COMMENT=0. Model: AI_MODEL (varsayılan claude-opus-5-5).
// • SDK (@anthropic-ai/sdk) yalnız gerektiğinde yüklenir; kurulu değilse ya da hata olursa yorum atlanır,
//   bot normal çalışmaya devam eder (yorum hiçbir zaman sinyalin önüne geçmez).
// • Yalnız verilen metrikler kullanılır; fiyat tahmini / kesin al-sat dili yasak (sistem talimatı).
// • Güvenlik reddinde sunucu tarafı yedek model devreye girer (fallbacks: "default").
export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.AI_COMMENT !== "0";
export const AI_MODEL = process.env.AI_MODEL || "claude-opus-5-5";

const SYSTEM = [
  "Sen bir ABD borsası analiz asistanısın. Kullanıcı sana JSON olarak hisse sinyalleri verir.",
  "Her hisse için Türkçe, 2-3 kısa cümlelik bir yorum yaz: sinyalin neden oluştuğunu YALNIZCA verilen metriklerle açıkla",
  "(momentum, zirveye uzaklık, RSI, SPY'a göre güç, stop/hedef, varsa haber başlıkları) ve en önemli riski belirt.",
  "Fiyat tahmini yapma, kesin dil kullanma ('kesin yükselir' gibi), yatırım tavsiyesi verme. Veride olmayan bilgi uydurma.",
  "Biçim: her hisse için tek satır, 'SEMBOL: yorum' şeklinde. Başka metin ekleme.",
].join(" ");

let _client = null, _Anthropic = null;
async function client() {
  if (_client) return _client;
  const mod = await import("@anthropic-ai/sdk");                     // kurulu değilse fırlatır → çağıran yakalar
  _Anthropic = mod.default;
  _client = new _Anthropic();
  return _client;
}
export function _setClient(c, A = null) { _client = c; _Anthropic = A; }   // testler için

// items: [{ sym, signal, ...metrikler }]. Dönüş: { SYM: "yorum" } (boş olabilir). Asla fırlatmaz.
export async function aiComments(items) {
  if (!aiEnabled() || !items?.length) return {};
  try {
    const c = await client();
    const r = await c.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,                                              // düşünme + kısa yorumlar için pay
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(items) }],
    });
    if (r.stop_reason === "refusal") { console.error("[AI] yorum reddedildi:", r.stop_details?.category ?? "?"); return {}; }
    const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const out = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*\**\s*([A-Z][A-Z.\-]{0,9})\s*\**\s*:\s*(.+)$/);
      if (m && items.some(i => i.sym === m[1])) out[m[1]] = m[2].trim().slice(0, 400);
    }
    return out;
  } catch (e) {
    const A = _Anthropic;
    if (A && e instanceof A.RateLimitError) console.error("[AI] hız sınırı — yorum atlandı");
    else if (A && e instanceof A.AuthenticationError) console.error("[AI] API anahtarı geçersiz — yorum atlandı");
    else if (A && e instanceof A.APIError) console.error(`[AI] API hatası ${e.status} — yorum atlandı`);
    else console.error("[AI] yorum atlandı:", e?.message || e);
    return {};
  }
}

// Sinyal için kısa, kişisel veri içermeyen metrik özeti
export const aiItem = (a, extra = {}) => ({
  sym: a.sym, signal: a.signal, price: a.price,
  mom12_pct: a.mom12 != null ? Math.round(a.mom12 * 100) : undefined,
  below_52w_high_pct: a.hi52 != null ? Math.round((1 - a.hi52) * 100) : undefined,
  rsi14: a.rsi, rel_strength_vs_spy_60d_pct: a.rs60, stop: a.stopLoss, target: a.target1,
  engine_confidence: a.confidence, ...extra,
});
