// AÇILIŞ ÖNCESİ GÜNLÜK MESAJ — SPY ve QQQ için o günün (gün içi) eğilimi, kontrat, hedef ve stop.
// Ölçüm (research/premarket.mjs, açılış→kapanış, eğitim < 2014 ≤ test). Tutarlı (iki dönem + iki ETF) sinyaller:
//   (1) VIX dün kapanışta > 30 (yüksek korku)            → o gün yukarı eğilim
//   (2) VIX dün ≥ +%10 yükseldi VE trend yukarı (200g üstü) → yukarı eğilim
//   (3) RSI(2) < 10 VE trend yukarı                        → yukarı eğilim
// Skor = sağlanan koşul sayısı. Skor ≥ 1 günlerde: SPY isabet %55–56, ort. +7…+10 bp; skor ≥ 2: %53–61, +12…+20 bp.
// Skor 0 (günlerin ~%84'ü): gün içi yön yazı-tura (%51–54) → NÖTR, işlem önerilmez.
// DÜŞÜŞ (put): açılış öncesi bilgiyle ölçülmüş avantaj YOK ("trend aşağı → sat", "yukarı boşluğu sat" test döneminde
// zarar) → sabah put önerilmez; bu her mesajda açıkça yazılır.
// Hedef/stop: tahmini açılış ± 0.5 × beklenen günlük hareket (VIX/√252; QQQ ×1.25). Skor ≥ 1 günlerde hedefe gün içinde
// ulaşma ~%48, stop'a ~%41.
import { rsiSeries, smaAt } from "../spot/etfsignal.mjs";
import { normCdf } from "../options/bs.mjs";

export const MORNING = { START: 450, END: 570, EM_K: 0.5 };   // 07:30–09:29 NY
export const FUT = { SPY: "ES=F", QQQ: "NQ=F" };
const HIST = {
  SPY: { 1: "isabet %55–56 · ort. +7…+10 bp", 2: "isabet %53–61 · ort. +12…+20 bp" },
  QQQ: { 1: "isabet %52–55 · ort. +12…+16 bp", 2: "isabet %48–56 · ort. +12…+24 bp" },
};

// closes: TAMAMLANMIŞ günlük kapanışlar (son = dün) · vix: tamamlanmış VIX kapanışları (son = dün)
export function morningScore(closes, vix) {
  const i = closes.length - 1;
  if (i < 200 || vix.length < 2) return null;
  const up200 = closes[i] > smaAt(closes, i, 200), rsi2 = rsiSeries(closes, 2)[i];
  const v = vix.at(-1), vChg = v / vix.at(-2) - 1;
  const conds = [
    { ok: v > 30, txt: `VIX > 30 (${v.toFixed(1)})` },
    { ok: up200 && vChg >= 0.10, txt: `VIX dün +%10↑ & trend yukarı (${(vChg * 100).toFixed(0)}%)` },
    { ok: up200 && rsi2 < 10, txt: `RSI(2) < 10 & trend yukarı (${rsi2.toFixed(1)})` },
  ];
  return { up200, rsi2, vix: v, vixChg: vChg, conds, score: conds.filter(c => c.ok).length };
}

export function levels(estOpen, vix, sym) {
  const em = (vix / 100) / Math.sqrt(252) * (sym === "QQQ" ? 1.25 : 1);
  return { em, target: +(estOpen * (1 + MORNING.EM_K * em)).toFixed(2), stop: +(estOpen * (1 - MORNING.EM_K * em)).toFixed(2) };
}

const pc = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
const trD = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// Ölçülmüş günlük yön avantajı (açılış→kapanış, ondalık): skor 1 / skor ≥ 2
const EDGE = { SPY: { 1: 0.0008, 2: 0.0015 }, QQQ: { 1: 0.0013, 2: 0.0015 } };
// Vade seçenekleri: [etiket, en az gün, en çok gün] (loadChain dte'si: vadeye kalan takvim günü, yuvarlanmış)
export const TENORS = [["0DTE (bugün)", 0, 0], ["1DTE (yarın)", 1, 3], ["Haftalık (~1 hafta)", 4, 9]];

// Alınan opsiyonun vadede kâr olasılığı: P(S_T başabaşın ötesinde), log-normal, kayma mu (yıllık), sigma (yıllık)
export function popLong(type, S, K, prem, T, sigma, mu = 0) {
  const be = type === "C" ? K + prem : K - prem;
  if (!(be > 0) || !(T > 0) || !(sigma > 0) || !(S > 0)) return null;
  const d = (Math.log(S / be) + (mu - sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return type === "C" ? normCdf(d) : normCdf(-d);
}
// Zincirden vade penceresindeki ilk vadede |delta| hedefe en yakın kotasyonlu kontrat. prem = orta + %30 spread
export function pickTenor(chain, lo, hi, type, delta) {
  const ex = (chain?.expiries || []).filter(e => e.dte >= lo && e.dte <= hi).sort((a, b) => a.dte - b.dte)[0];
  if (!ex) return null;
  const c = ((type === "P" ? ex.puts : ex.calls) || []).filter(o => o.delta != null && o.mid > 0 && o.ask >= o.bid)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - delta) - Math.abs(Math.abs(b.delta) - delta))[0];
  if (!c) return null;
  return { ex, c, S: chain.S, prem: +(c.mid + 0.3 * (c.ask - c.bid)).toFixed(2), expD: new Date(ex.exp * 1e3).toISOString().slice(0, 10) };
}

// deps: { today, closesFor(sym) → tamamlanmış kapanışlar, vixCloses(), futQuote(sym) → {price, prevClose},
//         contractFor(sym, type) → { K, exp (iso), dte, delta, mid, spreadPct } | null, headlines() → [str] }
// Dönüş: { text, calls: [kayıt] }
export async function buildMorning(deps) {
  const vix = await deps.vixCloses();
  const L = [], calls = [];
  const futs = {};
  for (const sym of Object.keys(FUT)) futs[sym] = await deps.futQuote(FUT[sym]).catch(() => null);
  const fx = s => futs[s]?.price && futs[s]?.prevClose ? futs[s].price / futs[s].prevClose - 1 : null;
  const v = vix.at(-1), vChg = vix.length > 1 ? v / vix.at(-2) - 1 : 0;
  L.push(`🌅 AÇILIŞ ÖNCESİ — SPY / QQQ gün içi eğilim · ${deps.today}`);
  L.push(`Duyarlılık: VIX ${v.toFixed(1)} (dün ${pc(vChg)}) · ${v > 30 ? "YÜKSEK KORKU" : v > 20 ? "gergin" : "sakin"} · vadeli: ES ${fx("SPY") != null ? pc(fx("SPY")) : "—"} · NQ ${fx("QQQ") != null ? pc(fx("QQQ")) : "—"}`);
  // Korku & Açgözlülük: 1 günlük etkisi tutarsız → gün içi skora katılmaz; 5–10 günlük etki ETF modülünde kullanılır
  const fgTxt = deps.fearGreed ? await deps.fearGreed().catch(() => null) : null;
  if (fgTxt) L.push(fgTxt + "\n   (gün içi skora katılmaz: 1 günlük etkisi ölçümde tutarsız; 5–10 günlük etkisi ETF fırsatlarında kullanılır)");
  for (const sym of ["SPY", "QQQ"]) {
    const closes = await deps.closesFor(sym);
    const s = closes && morningScore(closes, vix);
    if (!s) { L.push("", `${sym}: veri alınamadı.`); continue; }
    // Tahmini açılış: ön piyasa CANLI fiyat (Alpaca IEX, ≤ 10 dk) varsa o; yoksa vadeli değişimi (Yahoo, 10 dk gecikmeli)
    const pm = deps.liveNow ? await deps.liveNow(sym).catch(() => null) : null;
    const prev = closes.at(-1), estOpen = +(pm?.price > 0 ? pm.price : prev * (1 + (fx(sym) ?? 0))).toFixed(2);
    const src = pm?.price > 0 ? "ön piyasa canlı" : fx(sym) != null ? "vadeliden, 10 dk gecikmeli" : "dünkü kapanış";
    L.push("", `${sym} · dün $${prev.toFixed(2)} · tahmini açılış ~$${estOpen} (${src}) · trend ${s.up200 ? "yukarı (200g üstü)" : "aşağı (200g altı)"} · RSI(2) ${s.rsi2.toFixed(1)}`);
    L.push(`Koşullar: ${s.conds.map(c => `${c.ok ? "✓" : "✗"} ${c.txt}`).join(" · ")}`);
    if (s.score === 0) {
      L.push(`⏸ NÖTR — işlem önerilmez. Bu koşullarda gün içi yön geçmişte yazı-tura (isabet %51–54).`);
      continue;
    }
    const lv = levels(estOpen, v, sym);
    L.push(`📈 CALL (gün içi) · skor ${s.score}/3 · geçmiş: ${HIST[sym][Math.min(2, s.score)]} (1993–2026)`);
    L.push(`HEDEF ${sym} $${lv.target} (+${(MORNING.EM_K * lv.em * 100).toFixed(2)}%) · STOP $${lv.stop} (−${(MORNING.EM_K * lv.em * 100).toFixed(2)}%) · hiçbiri olmazsa KAPANIŞTA çık`);
    // Vade seçenekleri: 0DTE · 1DTE · haftalık — kâr olasılığı (vadede başabaşın ötesi; modelin ölçülmüş yön avantajıyla)
    const chain = deps.chainFor ? await deps.chainFor(sym).catch(() => null) : null;
    const mu = EDGE[sym][Math.min(2, s.score)] * 252, sigV = (v / 100) * (sym === "QQQ" ? 1.25 : 1);
    let first = null;
    for (const [lab, lo, hi] of TENORS) {
      const t = pickTenor(chain, lo, hi, "C", 0.5);
      if (!t) { L.push(`• ${lab}: uygun kotasyon yok — açılışta ATM call (${Math.round(estOpen)}C) fiyatını kontrol et`); continue; }
      first ||= t;
      const pop = popLong("C", estOpen, t.c.K, t.prem, Math.max(t.ex.T, 1 / 365), t.c.iv || sigV, mu);
      L.push(`• ${lab}: AL ${t.c.K}C · vade ${trD(t.expD)} · ~$${t.prem.toFixed(2)} · başabaş $${(t.c.K + t.prem).toFixed(2)} · kâr olasılığı ~%${pop != null ? Math.round(pop * 100) : "?"}`);
    }
    L.push(`  ↳ 0DTE en ucuz ama en riskli (zaman değeri gün içinde erir); haftalık daha affedici. Hedefte sat, stop'ta ya da prim −%50'de çık.`);
    calls.push({ d: deps.today, sym, score: s.score, estOpen, target: lv.target, stop: lv.stop, K: first?.c.K ?? null, exp: first?.expD ?? null });
  }
  // AŞIRI KORKU (Korku & Açgözlülük < 25): 2–3 haftalık call (5–10 günlük etki ölçülmüş, gün içi değil)
  if (deps.fg != null && deps.fg < 25) {
    L.push("", `😱 AŞIRI KORKU (${deps.fg}/100) — 2–3 hafta vadeli CALL (5–10 gün tut; endeks 50'ye dönünce çık)`);
    for (const sym of ["SPY", "QQQ"]) {
      const chain = deps.chainFor ? await deps.chainFor(sym).catch(() => null) : null;
      const t = pickTenor(chain, 14, 25, "C", 0.6);
      if (!t) { L.push(`• ${sym}: uygun kotasyon yok`); continue; }
      const sig = t.c.iv || (vix.at(-1) / 100) * (sym === "QQQ" ? 1.25 : 1);
      const pop = popLong("C", t.S, t.c.K, t.prem, t.ex.T, sig, 0.09);
      L.push(`• ${sym}: AL ${t.c.K}C · vade ${trD(t.expD)} (${t.ex.dte}g) · ~$${t.prem.toFixed(2)} · başabaş $${(t.c.K + t.prem).toFixed(2)} · vadede kâr olasılığı ~%${pop != null ? Math.round(pop * 100) : "?"}`);
    }
    L.push("  ↳ Geçmiş (2008–2026): aşırı korkuda 10 gün sonra SPY ort. +%0.6–0.7, QQQ +%0.8–1.0 (taban +%0.3–0.8).");
  }
  L.push("", "PUT notu: açılış öncesi bilgilerle düşüş yönünde ölçülmüş avantaj yok (test döneminde zarar) → sabah put önerilmez. Gün içi düşüş sinyali oluşursa ETF modülü ayrıca PUT bildirir.");
  const h = await deps.headlines().catch(() => []);
  if (h.length) L.push("", "📰 Başlıklar:", ...h.slice(0, 4).map(x => "• " + x));
  L.push("", "Gün içi işlem: opsiyon hızlı değer kaybedebilir; prim hesabın en çok %1–2'si olsun. ⚠ Yatırım tavsiyesi değildir.");
  return { text: L.join("\n"), calls };
}

// Sabah çağrılarının sonucu: o günün mumuyla (açılış, en yüksek, en düşük, kapanış). bars(sym) → [{d, open, high, low, close}]
export async function settleMorning(book, today, bars) {
  const done = [];
  for (const b of book) {
    if (b.res || b.d >= today) continue;
    const bar = (await bars(b.sym)).find(x => x.d === b.d);
    if (!bar) continue;
    b.res = { open: bar.open, oc: +(bar.close / bar.open - 1).toFixed(4), tHit: bar.high >= b.target, sHit: bar.low <= b.stop };
    done.push(b);
  }
  return done;
}

export function fmtMorningBook(book) {
  const r = (book || []).filter(b => b.res);
  const L = ["🌅 SABAH KARNESİ (SPY/QQQ gün içi call çağrıları)"];
  if (!r.length) return L.concat("Henüz sonuçlanan çağrı yok.").join("\n");
  const n = r.length, up = r.filter(b => b.res.oc > 0).length, t = r.filter(b => b.res.tHit).length, s = r.filter(b => b.res.sHit).length;
  L.push(`${n} çağrı · gün yukarı kapandı %${Math.round(up / n * 100)} · hedef görüldü %${Math.round(t / n * 100)} · stop görüldü %${Math.round(s / n * 100)} · ort. açılış→kapanış ${pc(r.reduce((a, b) => a + b.res.oc, 0) / n)}`);
  for (const b of r.slice(-5)) L.push(`• ${b.d} ${b.sym} skor ${b.score} · ${pc(b.res.oc)} · hedef ${b.res.tHit ? "✓" : "✗"} · stop ${b.res.sHit ? "✓" : "✗"}`);
  return L.join("\n");
}
