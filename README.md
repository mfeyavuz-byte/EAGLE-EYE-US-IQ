# 🇺🇸 ABD BOT — Spot + Opsiyon öneri botu (Telegram)

GitHub Actions üzerinde kendi kendine çalışır, sunucu gerekmez. Teknik motor bist-bot'tan alındı
(19 indikatör, `getSignals`); veri ABD için ücretsiz kaynaklardan gelir. Bağımlılık yok (Node 20+).

## Durum
| Faz | İçerik | Durum |
|---|---|---|
| 1 | Veri · motor · spot tarama · Telegram sinyal + komutlar | ✅ |
| 1b | Evren: **S&P 500 + Nasdaq'ın tamamı** (likidite filtreli, haftalık yenilenir) | ✅ |
| 3 | **Opsiyon motoru**: kendi IV/Greek hesabı, oynaklık rejimi, vade yapısı, skew, kalın kuyruklu EV, strateji seçici, `/opsiyon` | ✅ |
| 2 | Temel analiz: SEC EDGAR (marj, büyüme, F-skoru, sulandırma, Form 4) | ⏳ |
| 4 | Sanal portföy (spot + opsiyon) | ⏳ |
| 5 | ABD backtest kalibrasyonu + LLM yorum | ⏳ |

## Ne yapar
**Spot** — seans boyunca 20 dk'da bir evreni tarar, filtreyi geçen **yeni** AL/SAT sinyallerini yollar.
Filtre: güven ≥ 65 · ADX ≥ 20 · ort. işlem hacmi ≥ 20M$ · haftalık trendle uyum · AL için RSI < 63 ve hacim temposu ≥ 0.7×.

**Opsiyon** — günde 2 kez (10:15 ve 14:00 New York) en iyi 6 opsiyon fikri + istek üzerine `/opsiyon SEMBOL`.
Karar zinciri:
1. **Yön**: spot sinyali ve güveni (güven < %60 → nötr sayılır).
2. **Oynaklık rejimi**: IV rank (≥20 günlük geçmiş varsa) yoksa IV/HV oranı → *ucuz / adil / zengin*.
3. **Olay**: bilanço vade içindeyse prim SATAN yapılar (kredili spread, iron condor) o vadede yasak;
   oynaklık avantajı iddia edilmez. Ters vade yapısı uyarısı.
4. **Matris**:

| Yön \ IV | ucuz | adil | zengin |
|---|---|---|---|
| Yukarı | long call · bull call spread | bull call · bull put spread | bull put · bull call spread |
| Aşağı | long put · bear put spread | bear put · bear call spread | bear call · bear put spread |
| Nötr | — (bekle) | iron condor (IV/HV ≥ 1.1 ise) | iron condor |

5. **Her aday** 14–75 gün vadede, delta aralıklarıyla kurulur ve **gerçekçi dolumla** (orta ± %30 spread) fiyatlanır.
   - **Dayanak fiyatı zincirden** (put-call paritesi) alınır: hisse kotasyonu ile opsiyon kotasyonları farklı anlarda
     alınmış olabilir; bu fark IV'yi ve olasılıkları bozar.
   - IV ve Greek'ler her kontrat için **kendimiz** hesaplanır (Yahoo'nun IV alanı illikit strike'larda güvenilmez).
   - **Piyasanın** kâr olasılığı: log-normal, ATM IV, piyasa skew'unun tamamı.
   - **Bizim** kâr olasılığımız ve **beklenen değer (EV)**: kalın kuyruklu Student-t (ν=4) + sola çarpıklık
     (piyasa skew'unun %70'i), σ = 0.6·(0.9·IV) + 0.4·max(YZ20, ort(YZ20, HV60)), kayma = r − q (piyasayla aynı)
     + sinyal yönünde en fazla 0.15σ eğim. Bilanço vade içindeyse σ ≥ IV, vade yapısı tersse σ ≥ 0.95·IV.
   - EV **ikiye ayrılır**: fiyatlama farkı (oynaklık/skew) ve yön tahmini — hangisine güvendiğini görürsün.
   - Ayrıca en kötü %5 senaryo ortalaması (CVaR) ve net Greek'ler.
6. **Eleme**: EV ≤ 0 veya EV/maks zarar < %3 → elenir; kredili yapılarda kâr olasılığı ≥ %55, borçlularda ≥ %30;
   bacak başına OI ≥ 100 ve spread ≤ %12. Sıralama: avantaj − spread maliyeti + olasılık − vade sapması.
7. Her fikirde **boyut** (hesabın %2 riski) ve **yönetim kuralı** (kredili: %50 kârda kapat, 21 gün kala çık, 2× kredi zararda dur).

8. **Yoğunlaşma koruması** (günlük liste): aynı stratejiden ≤ 3, aynı sektörden ≤ 2, aynı yönden ≤ 4 fikir.
   Alternatif yoksa daha az fikir gider — 6 kopya bahis gönderilmez.

Yalnızca **riski sınırlı** yapılar önerilir (çıplak opsiyon satışı yok).

**Karne (`/karne`)**: Gönderilen her fikir kaydedilir; vade geçince dayanağın vade günü kapanışıyla sonuçlandırılır.
Gerçekleşen kazanma oranı modelin tahmini POP'uyla, gerçekleşen K/Z tahmini EV'yle karşılaştırılır. Model kendini
abartıyorsa karne bunu gösterir → `OPT_TILT` / ağırlıklar düşürülür. **Bu bir tahmin motorudur; karne onun ölçüsüdür.**

**IV geçmişi**: Ücretsiz kaynak IV geçmişi vermez; bot her gün 15:00 NY sonrası en likit 250 hisse + SPY/QQQ/IWM için
IV30 kaydeder (Gist, `abd_ivhist.json`). ~20 işlem gününden sonra IV rank devreye girer; o zamana kadar IV/HV kullanılır.

### Komutlar
`/hisse NVDA` · `/opsiyon AAPL` · `/sinyaller` · `/karne` · `/durum` · `/yardim`
> Komutlar bot çalışırken okunur (seans içinde ~20 dk gecikmeyle).

## Kurulum
1. **Yeni Telegram botu:** @BotFather → `/newbot` → token. @userinfobot → chat ID. Kendi botuna `/start` yaz.
   ⚠ bist-bot ile **aynı token'ı kullanma** — iki bot aynı token'dan komut okursa birbirinin komutlarını yutar.
2. **Gist:** gist.github.com → dosya `abd_state.json`, içerik `{}` → *secret gist* → URL'deki ID.
   Token: GitHub → Settings → Developer settings → Tokens (classic) → sadece `gist` izni.
3. **Alpaca (şiddetle önerilir):** alpaca.markets → ücretsiz hesap → Paper Trading → API Keys.
   - Tüm evrenin günlük mumlarını **toplu** çeker (~60 istek). Yoksa Yahoo'dan sembol başına istek gider ve
     istek sınırı (429) yüzünden tam tarama **saatte bire** düşürülür (aradaki run'larda en likit 300 hisse).
   - Canlı IEX fiyatı + resmî tatil takvimi.
4. Repo → Settings → Secrets and variables → Actions:

| Secret | Zorunlu |
|---|---|
| `TG_TOKEN`, `TG_CHAT` | ✅ |
| `GH_GIST_TOKEN`, `GIST_ID` | ✅ (yoksa durum ve IV geçmişi kaybolur) |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | önerilir |

5. Actions → **ABD BOT — Spot + Opsiyon** → Run workflow (`force` işaretli) → Telegram'a mesaj düşmeli.

## Yerel kullanım
```bash
npm test                                         # birim testleri (BS, IV, dağılım, stratejiler, filtreler)
npm run dry                                      # Telegram'a göndermeden tam tarama
DRY_RUN=1 FORCE=1 OPT_FORCE=1 SYMBOLS=AAPL,NVDA,SPY node bot/run.mjs   # opsiyon fikirleri dahil
npm run universe                                 # evreni yeniden kur (spot/universe.json)
npm run backtest                                 # spot eşiklerinin ABD'deki isabeti
```
Ayarlar (env): `MIN_CONF`, `MIN_ADX`, `MAX_RSI_BUY`, `MIN_DVOL`, `CORE_N` · opsiyon: `OPT_MIN_EDGE`, `OPT_ACCOUNT`,
`OPT_RISK`, `OPT_MIN_OI`, `OPT_MAX_SPREAD`, `OPT_SLIP`, `OPT_TILT`, `IV_TOP`.

## Dosyalar
```
core/engine.mjs        teknik motor (bist-bot kopyası)          core/backtest.mjs   spot backtest
data/yahoo.mjs         mum + opsiyon zinciri + risksiz faiz     data/alpaca.mjs     toplu mum, canlı fiyat, saat
data/market.mjs        NY seans saatleri
universe/build.mjs     S&P 500 + Nasdaq → likidite → spot/universe.json
spot/scan.mjs          analiz + kalite filtresi + tarama
options/bs.mjs         Black-Scholes, Greek'ler, IV çözücü
options/dist.mjs       log-normal & Student-t dağılım, EV/POP/CVaR, kâr-zarar profili
options/chain.mjs      zincir yükleme + kendi IV/delta hesabı + likidite
options/vol.mjs        HV (C2C, Yang-Zhang), ATM IV, IV30, vade yapısı, skew, beklenen hareket, rejim
options/strategies.mjs riski sınırlı strateji adayları
options/engine.mjs     yön × rejim × olay → aday → EV → seçim
options/ivhist.mjs     IV30 geçmişi (IV rank)
options/book.mjs       opsiyon karnesi (kayıt → vade sonu sonuç → kalibrasyon)
options/format.mjs     Telegram mesajları
bot/run.mjs            ana akış + komutlar          bot/state.mjs  Gist          bot/telegram.mjs  Telegram
```

## Veri notları ve sınırlar
- Opsiyon zinciri Yahoo'dan (gecikmeli/yaklaşık olabilir). **Emir öncesi canlı fiyatı kontrol et.**
- Modeller Avrupa tipi BS varsayar; Amerikan erken kullanımı derin ITM put'larda küçük sapma yaratır.
- EV modeli bir **tahmindir**: kalın kuyruk ve spread kayması dahil edilse de gerçek sonuç farklı olabilir.

> ⚠ Yatırım tavsiyesi değildir. Kişisel kullanım içindir.
