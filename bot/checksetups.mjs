// Araştırma sonuçları güncel mi? Kurulum listesi (abd_setups.json) ya da tutuş testi (abd_hold.json) yoksa / 8 günden eskiyse
// "STALE:setups" / "STALE:hold" yazar (ikisi de olabilir) → iş akışı ilgili araştırmayı tetikler. Güncelse "OK".
import { loadFiles, READ_FAILED, gistEnabled } from "./state.mjs";
import { SETUPS_FILE } from "./setuplive.mjs";
import { HOLD_FILE } from "./hold.mjs";
import { TA_FILE } from "./ta.mjs";
if (!gistEnabled()) { console.log("OK"); process.exit(0); }
const f = await loadFiles([SETUPS_FILE, HOLD_FILE, TA_FILE]);
if (f === READ_FAILED) { console.log("OK"); process.exit(0); }                    // okunamadı → bu sefer tetikleme
const old = d => !d || Date.now() - Date.parse(d + "T00:00:00Z") > 8 * 864e5;
const out = [];
if (old(f[SETUPS_FILE]?.d) || !(f[SETUPS_FILE] && "model" in f[SETUPS_FILE])) out.push("STALE:setups");   // eski biçim → yenile
if (old(f[HOLD_FILE]?.d)) out.push("STALE:hold");
if (old(f[TA_FILE]?.d)) out.push("STALE:ta");
console.log(out.length ? out.join(" ") : "OK");
