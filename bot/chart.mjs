// FİYAT GRAFİĞİ — quickchart.io (Chart.js) görüntü URL'si; Telegram görüntüyü kendisi indirir.
// Gönderilen yalnızca herkese açık fiyat verisidir (kişisel veri yok). CHARTS=0 ile kapatılır.
export const chartsEnabled = () => process.env.CHARTS !== "0";

// rows: günlük mumlar · levels: { stop, target, entry } (isteğe bağlı). Son ~120 gün + 50/200 gün ortalaması.
export function chartUrl(sym, rows, levels = {}) {
  const n = Math.min(120, rows.length);
  const start = rows.length - n;
  const sma = (k, p) => { if (k < p - 1) return null; let s = 0; for (let j = k - p + 1; j <= k; j++) s += rows[j].close; return +(s / p).toFixed(2); };
  const labels = [], close = [], s50 = [], s200 = [];
  for (let k = start; k < rows.length; k++) {
    const d = new Date(rows[k].ts);
    labels.push(`${d.getUTCDate()}.${d.getUTCMonth() + 1}`);
    close.push(+rows[k].close.toFixed(2)); s50.push(sma(k, 50)); s200.push(sma(k, 200));
  }
  const flat = (v, label, color) => ({ label, data: labels.map(() => v), borderColor: color, borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false });
  const ds = [
    { label: sym, data: close, borderColor: "#1f6feb", borderWidth: 2, pointRadius: 0, fill: false },
    { label: "50g", data: s50, borderColor: "#f0883e", borderWidth: 1, pointRadius: 0, fill: false },
    { label: "200g", data: s200, borderColor: "#8b949e", borderWidth: 1, pointRadius: 0, fill: false },
  ];
  if (levels.stop) ds.push(flat(levels.stop, "stop", "#da3633"));
  if (levels.target) ds.push(flat(levels.target, "hedef", "#2ea043"));
  const cfg = { type: "line", data: { labels, datasets: ds },
    options: { plugins: { legend: { labels: { boxWidth: 10 } } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } } };
  return `https://quickchart.io/chart?w=700&h=350&bkg=white&v=4&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}
