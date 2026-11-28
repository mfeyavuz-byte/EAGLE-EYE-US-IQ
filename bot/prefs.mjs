// KULLANICI AYARLARI — hangi mesajlar gelsin (/ayarlar) ve hesap büyüklüğüne göre kontrat sayısı (/hesap).
// Ayarlar durum dosyasında (st.prefs) + küçük Gist dosyasında (abd_prefs.json; 15 dk ve ani hareket süreçleri okur).
export const PREFS_FILE = "abd_prefs.json";
export const PREF_KEYS = {
  sabah: "Sabah mesajı", premarket: "Açılış öncesi hareketliler", plan15: "15 dk plan (SPY/QQQ/GLD/SLV)", saatlik: "Saatlik 25 hisse",
  kurulum: "Ölçülmüş kurulumlar", ani: "Ani hareket alarmı", cikis: "Çıkış mesajları", spot: "Hisse AL/SAT sinyalleri",
  donus: "Aşırı satım dönüşü", bilanco: "Bilanço straddle", pozisyon: "Pozisyon uyarıları", gunsonu: "Gün sonu karne", tutus: "1–2 ay tutuş listesi",
};
export const defaultPrefs = () => ({ on: {}, acct: null, risk: 0.01 });
export const isOn = (p, k) => p?.on?.[k] !== false;                  // varsayılan: açık

export function prefsText(p) {
  const L = ["⚙️ Mesaj ayarları (dokun: aç/kapat)"];
  for (const [k, lab] of Object.entries(PREF_KEYS)) L.push(`${isOn(p, k) ? "✅" : "❌"} ${lab}`);
  L.push(p?.acct ? `💰 Hesap $${Math.round(p.acct).toLocaleString("en-US")} · işlem başı risk %${+(p.risk * 100).toFixed(2)} → mesajlarda kontrat sayısı` : "💰 Hesap girilmedi → kontrat sayısı yok. Örnek: /hesap 25000 1");
  return L.join("\n");
}
export const prefsButtons = p => {
  const ks = Object.keys(PREF_KEYS), rows = [];
  for (let i = 0; i < ks.length; i += 3) rows.push(ks.slice(i, i + 3).map(k => ({ text: `${isOn(p, k) ? "✅" : "❌"} ${k}`, data: `/ayarlar ${k}` })));
  return rows;
};

// "/ayarlar" · "/ayarlar saatlik" (değiştir) · "/ayarlar saatlik kapat|aç" → { p, changed, msg }
export function applyPrefCmd(p0, args) {
  const p = { ...defaultPrefs(), ...(p0 || {}), on: { ...(p0?.on || {}) } };
  const [k, v] = (args || []).map(x => String(x).toLowerCase());
  if (!k) return { p, changed: false, msg: prefsText(p) };
  if (!PREF_KEYS[k]) return { p, changed: false, msg: `Bilinmeyen ayar: ${k}\n` + prefsText(p) };
  const want = v ? !/^(kapat|kapalı|off|0|hayır)$/.test(v) : !isOn(p, k);
  p.on[k] = want;
  return { p, changed: true, msg: `${want ? "✅" : "❌"} ${PREF_KEYS[k]} ${want ? "açıldı" : "kapatıldı"}.\n\n` + prefsText(p) };
}

// "/hesap 25000" · "/hesap 25000 1.5" (%) · "/hesap sil"
export function applyAcctCmd(p0, args) {
  const p = { ...defaultPrefs(), ...(p0 || {}), on: { ...(p0?.on || {}) } };
  const a = (args || []).map(x => String(x).replace(/[$,%]/g, ""));
  if (a[0] === "sil") { p.acct = null; return { p, changed: true, msg: "💰 Hesap bilgisi silindi; kontrat sayısı gösterilmeyecek." }; }
  const acct = +a[0], risk = a[1] != null ? +a[1] / 100 : p.risk;
  if (!(acct >= 100) || !(risk > 0 && risk <= 0.1)) return { p, changed: false, msg: "Kullanım: /hesap HESAP [RİSK%] — örn. /hesap 25000 1 (işlem başı hesabın %1'i riske)" };
  p.acct = acct; p.risk = risk;
  return { p, changed: true, msg: `💰 Hesap $${Math.round(acct).toLocaleString("en-US")} · işlem başı risk %${+(risk * 100).toFixed(2)} ($${Math.round(acct * risk)}). Fikirlerde kontrat sayısı yazacak.` };
}

// Kontrat sayısı: stopta kontrat başı kayıp = (prim − stoptaki değer) × 100 (en az primin %30'u) → risk bütçesine göre adet
export function sizeLine(p, prem, atStop, mult = 1) {
  if (!p?.acct || !(prem > 0)) return null;
  const per = Math.max(prem - (atStop ?? 0), prem * 0.3) * 100, budget = p.acct * (p.risk || 0.01) * (mult > 0 ? mult : 1), n = Math.floor(budget / per);
  if (n < 1) return `Boyut: 1 kontrat bile riskinden büyük (stopta ~$${Math.round(per)} kayıp > $${Math.round(budget)}) → atla ya da küçült`;
  return `Boyut: ${n} kontrat (stopta ~$${Math.round(n * per)} kayıp = hesabın %${+((n * per) / p.acct * 100).toFixed(2)})`;
}
