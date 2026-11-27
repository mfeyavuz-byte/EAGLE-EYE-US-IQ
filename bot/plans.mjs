// İŞLEM PLANI (her mesajda, fırsat olsa da olmasa da) — 5 dk mumlardan:
//   Eğilim: fiyat VWAP'ın ve EMA9/EMA21 sıralamasının aynı tarafındaysa ↑/↓, karışıksa →.
//   CALL planı: son 30 dk tepesinin biraz üstü kırılırsa giriş · stop giriş − R · hedef giriş + 2R
//   PUT planı : son 30 dk dibinin biraz altı kırılırsa giriş · stop giriş + R · hedef giriş − 2R
//   R = max(1 × ATR(5 dk), 30 dk aralığının yarısı) → oynaklığa göre ölçeklenir.
// Kırılım (stop-giriş) planıdır: fiyat seviyeye gelmezse işlem yok. Eğilim yönündeki plan öncelikli.
import { dayFeatures } from "./setups.mjs";

export function tradePlan(bars, S = null) {
  if (!bars || bars.length < 3) return null;
  const f = dayFeatures(bars), i = bars.length - 1, A = f.atr[i];
  S = S > 0 ? S : bars[i].close;
  const last = bars.slice(-6), H = Math.max(...last.map(b => b.high)), L = Math.min(...last.map(b => b.low));
  const buf = 0.1 * A, R = Math.max(A, (H - L) / 2);
  const up = (S > f.vwap[i] ? 1 : -1) + (f.e9[i] > f.e21[i] ? 1 : -1);
  const r2 = x => +x.toFixed(2);
  const cE = Math.max(H + buf, S + buf), pE = Math.min(L - buf, S - buf);              // giriş her zaman fiyatın doğru tarafında
  return {
    S: r2(S), vwap: r2(f.vwap[i]), trend: up >= 2 ? "↑" : up <= -2 ? "↓" : "→",
    call: { entry: r2(cE), stop: r2(cE - R), target: r2(cE + 2 * R) },
    put: { entry: r2(pE), stop: r2(pE + R), target: r2(pE - 2 * R) },
    dayChg: bars[0].open ? S / bars[0].open - 1 : null,
  };
}

const n2 = x => x.toFixed(2);
// 15 dk mesajı için (3 satır) — contract: eğilim yönündeki kontrat metni (ops.)
export function fmtPlan(sym, p, contract = null) {
  const tr = p.trend === "↑" ? "↑ yükseliş eğilimi" : p.trend === "↓" ? "↓ düşüş eğilimi" : "→ yön belirsiz";
  const c = `  🟢 CALL ${n2(p.call.entry)} üstü → hedef ${n2(p.call.target)} · stop ${n2(p.call.stop)}`;
  const q = `  🔴 PUT ${n2(p.put.entry)} altı → hedef ${n2(p.put.target)} · stop ${n2(p.put.stop)}`;
  const k = contract ? `  Kontrat (${p.trend === "↓" ? "PUT" : "CALL"}): ${contract}` : null;
  const lines = p.trend === "↓" ? [q, c] : [c, q];
  return [`${sym} ${n2(p.S)} · ${tr}`, ...lines, ...(k && p.trend !== "→" ? [k] : [])].join("\n");
}
// Saatlik liste için (tek satır)
export function fmtPlanLine(sym, p) {
  return `${sym} ${n2(p.S)} ${p.trend} · CALL >${n2(p.call.entry)} h${n2(p.call.target)} s${n2(p.call.stop)} · PUT <${n2(p.put.entry)} h${n2(p.put.target)} s${n2(p.put.stop)}`;
}
