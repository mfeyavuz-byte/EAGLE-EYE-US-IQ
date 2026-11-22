// Kalıcı durum — GitHub Gist (Actions makinesi her run'da sıfırlanır).
// Okuma BAŞARISIZ ile gerçekten BOŞ ayrımı: başarısızlıkta READ_FAILED → çağıran ASLA yazmaz (bist-bot dersi).
// Dosyalar: abd_state.json (bot durumu), abd_ivhist.json (IV30 geçmişi — IV rank için).
const TOKEN = process.env.GH_GIST_TOKEN || "";
const ID = process.env.GIST_ID || "";
export const STATE_FILE = "abd_state.json";
export const IVHIST_FILE = "abd_ivhist.json";
export const READ_FAILED = Symbol("gist_read_failed");
export const gistEnabled = () => !!(TOKEN && ID);
const H = { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" };

// Dönüş: { [dosya]: nesne } — dosya yoksa {}. Başarısızlıkta READ_FAILED.
export async function loadFiles(names) {
  if (!gistEnabled()) return Object.fromEntries(names.map(n => [n, {}]));
  try {
    const r = await fetch(`https://api.github.com/gists/${ID}`, { headers: H });
    if (!r.ok) return READ_FAILED;
    const g = await r.json();
    const out = {};
    for (const n of names) {
      const f = g.files?.[n];
      if (!f) { out[n] = {}; continue; }
      let c = f.content;
      if (f.truncated && f.raw_url) {                  // 1 MB üstü dosyalar API'de kesilir → ham adresten al
        const rr = await fetch(f.raw_url, { headers: { Authorization: "Bearer " + TOKEN } });
        if (!rr.ok) return READ_FAILED;
        c = await rr.text();
      }
      out[n] = c ? JSON.parse(c) : {};
    }
    return out;
  } catch { return READ_FAILED; }
}

// BOYUT KORUMASI: durum dosyası LIMIT'i aşarsa en eski KAPANMIŞ kayıtlar budanır (açık pozisyonlara dokunulmaz).
// Sıra: kapanmış spot sinyalleri → sonuçlanmış opsiyon fikirleri. Dönüş: silinen kayıt sayısı.
export const STATE_LIMIT = 700e3;
export function trimState(st, limit = STATE_LIMIT) {
  let removed = 0;
  const size = () => JSON.stringify(st).length;
  for (const key of ["spotBook", "optBook"]) {
    const arr = st[key];
    if (!Array.isArray(arr)) continue;
    while (size() > limit) {
      const i = arr.findIndex(b => b.closed && (key === "spotBook" || b.settled));
      if (i < 0) break;
      arr.splice(i, 1); removed++;
    }
  }
  return removed;
}

export async function saveFiles(files) {
  if (!gistEnabled()) return false;
  for (const [n, o] of Object.entries(files)) {
    const kb = JSON.stringify(o).length / 1e3;
    if (kb > 900) console.error(`⚠ [Gist] ${n} ${kb.toFixed(0)} KB — 1 MB sınırına yakın`);
  }
  try {
    const body = { files: Object.fromEntries(Object.entries(files).map(([n, o]) => [n, { content: JSON.stringify(o) }])) };
    const r = await fetch(`https://api.github.com/gists/${ID}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) console.error("[Gist] yazılamadı", r.status);
    return r.ok;
  } catch (e) { console.error("[Gist]", e.message); return false; }
}
