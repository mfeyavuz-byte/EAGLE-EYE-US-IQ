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
  for (const sym of ["SPY", "QQQ"]) {
    const closes = await deps.closesFor(sym);
    const s = closes && morningScore(closes, vix);
    if (!s) { L.push("", `${sym}: veri alınamadı.`); continue; }
    const prev = closes.at(-1), estOpen = +(prev * (1 + (fx(sym) ?? 0))).toFixed(2);
    L.push("", `${sym} · dün $${prev.toFixed(2)} · tahmini açılış ~$${estOpen} · trend ${s.up200 ? "yukarı (200g üstü)" : "aşağı (200g altı)"} · RSI(2) ${s.rsi2.toFixed(1)}`);
    L.push(`Koşullar: ${s.conds.map(c => `${c.ok ? "✓" : "✗"} ${c.txt}`).join(" · ")}`);
    if (s.score === 0) {
      L.push(`⏸ NÖTR — işlem önerilmez. Bu koşullarda gün içi yön geçmişte yazı-tura (isabet %51–54).`);
      continue;
    }
    const lv = levels(estOpen, v, sym);
    L.push(`📈 CALL (gün içi) · skor ${s.score}/3 · geçmiş: ${HIST[sym][Math.min(2, s.score)]} (1993–2026)`);
    L.push(`HEDEF ${sym} $${lv.target} (+${(MORNING.EM_K * lv.em * 100).toFixed(2)}%) · STOP $${lv.stop} (−${(MORNING.EM_K * lv.em * 100).toFixed(2)}%) · hiçbiri olmazsa KAPANIŞTA çık`);
    const c = await deps.contractFor(sym, "C").catch(() => null);
    L.push(c ? `Kontrat: AL ${c.K}C · vade ${trD(c.exp)} (${c.dte}g) · delta ${c.delta.toFixed(2)} · son ~$${c.mid.toFixed(2)} — açılışta canlı fiyatı kontrol et`
      : `Kontrat: ATM call (${Math.round(estOpen)}C), en yakın ≥2 günlük vade — açılış öncesi kotasyon yok, açılışta fiyatı kontrol et`);
    calls.push({ d: deps.today, sym, score: s.score, estOpen, target: lv.target, stop: lv.stop, K: c?.K ?? null, exp: c?.exp ?? null });
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
