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
Filtre (ABD için sıkılaştırıldı; BIST eşikleriyle 1.328 hissenin 414'ü geçiyordu):
- Ortak: ort. işlem hacmi ≥ 50M$.
- **AL**: güven ≥ 75 · ADX ≥ 20 · haftalık trend aşağı değil · **SPY'dan güçlü** (60g göreli güç > 0) · RSI < 63 ·
  hacim temposu ≥ 0.7× (dip dönüşü sinyalleri trend/göreli güç şartından muaf).
- **SAT**: güven ≥ 80 · ADX ≥ 25 · haftalık trend AŞAĞI · SPY'dan zayıf · RSI ≥ 30 (aşırı satılmışa geç SAT yok).
- Sıralama: kalite puanı (güven + trend gücü + göreli güç + hacim). **Günlük kota**: en iyi 10 AL + 6 SAT;
  kalanlar `/sinyaller` ile görülür.

**Opsiyon** — günde 2 kez (10:15 ve 14:00 New York) en iyi 6 opsiyon fikri + istek üzerine `/opsiyon SEMBOL`.
Karar zinciri:
1. **Yön**: spot sinyali — yalnızca spot filtresini geçmişse (aksi halde nötr sayılır).
2. **Oynaklık rejimi**: IV rank (≥20 günlük geçmiş varsa) yoksa IV/HV oranı → *ucuz / adil / zengin*.
3. **Olay / stres**: bilanço vade içindeyse prim SATAN yapılar (kredili spread, iron condor) o vadede yasak;
   oynaklık avantajı iddia edilmez. Vade yapısı ters (> 1.10) → σ ≥ IV (oynaklık avantajı iddia edilmez);
   **belirgin ters (> 1.25) → iron condor yasak** (yönsüz prim satışı stres dönemlerinde en çok yara alan işlemdir).
4. **Matris**:

| Yön \ IV | ucuz | adil | zengin |
|---|---|---|---|
| Yukarı | long call · bull call spread | bull call · bull put spread | bull put · bull call spread |
| Aşağı | long put · bear put spread | bear put · bear call spread | bear call · bear put spread |
| Nötr | — (bekle) | iron condor (IV/HV ≥ 1.1 ise) | iron condor |

*(Nötr satırı vade yapısı > 1.25 iken boştur.)*

5. **Her aday** 14–75 gün vadede, delta aralıklarıyla kurulur ve **gerçekçi dolumla** (orta ± %30 spread) fiyatlanır.
   - **Dayanak fiyatı zincirden** (put-call paritesi) alınır: hisse kotasyonu ile opsiyon kotasyonları farklı anlarda
     alınmış olabilir; bu fark IV'yi ve olasılıkları bozar.
   - IV ve Greek'ler her kontrat için **kendimiz** hesaplanır (Yahoo'nun IV alanı illikit strike'larda güvenilmez).
   - **Piyasanın** kâr olasılığı: log-normal, ATM IV, piyasa skew'unun tamamı.
   - **Bizim** kâr olasılığımız ve **beklenen değer (EV)**: kalın kuyruklu Student-t (ν=4) + sola çarpıklık
     (piyasa skew'unun %70'i), σ = 0.6·(0.9·IV) + 0.4·max(YZ20, ort(YZ20, HV60)), kayma = r − q (piyasayla aynı)
     + sinyal yönünde en fazla 0.15σ eğim. Bilanço vade içindeyse ya da vade yapısı tersse σ ≥ IV.
   - EV **ikiye ayrılır**: fiyatlama farkı (oynaklık/skew) ve yön tahmini — hangisine güvendiğini görürsün.
   - **Yön payına güven %50**: eleme ve sıralamada yön kaynaklı EV yarı ağırlıkla sayılır (`OPT_DIR_TRUST`).
     Spot sinyalinin ABD isabeti doğrulanana dek avantajı yalnızca yön tahminine dayanan fikir geçmez.
   - Ayrıca en kötü %5 senaryo ortalaması (CVaR) ve net Greek'ler.
6. **Eleme**: EV ≤ 0 veya (yön payı indirimli) EV/maks zarar < %3 → elenir; kredili yapılarda kâr olasılığı ≥ %55, borçlularda ≥ %30;
   bacak başına OI ≥ 100 ve spread ≤ %12. Sıralama: avantaj − spread maliyeti + olasılık − vade sapması.
7. Her fikirde **boyut** (hesabın %2 riski) ve **yönetim kuralı** — dolar tutarlarıyla:

| Yapı | Kâr al | Zarar durdur | Süre |
|---|---|---|---|
| Kredili (bull put, bear call, condor) | maks kârın %50'si | 2× kredi zarar (maks zarardan küçükse) · kısa strike kırılırsa | vadeye 21 gün |
| Borçlu spread | maks kârın %75'i | ödenen primin %50'si | vadeye 10 gün |
| Long call / put | +%100 | primin %50'si | vadeye 21 gün |

8. **Yoğunlaşma koruması** (günlük liste): aynı stratejiden ≤ 3, aynı sektörden ≤ 2, aynı yönden ≤ 4 fikir.
   Alternatif yoksa daha az fikir gider — 6 kopya bahis gönderilmez.

Yalnızca **riski sınırlı** yapılar önerilir (çıplak opsiyon satışı yok).

**Karne (`/karne`)**: Gönderilen her fikir kaydedilir ve iki ayrı şekilde ölçülür:
- **Gerçekçi (yönetilmiş):** Açık fikirler her gün 15:00 NY sonrası bacakların **canlı alış/satış** fiyatlarıyla
  değerlenir (kapatma fiyatı orta ∓ %30 spread — bizim aleyhimize). Yukarıdaki yönetim kurallarından biri tetiklenince
  fikir kapanır ve Telegram'a **"📕 OPSİYON FİKRİ KAPAT"** mesajı gelir. Karne: kazanma oranı, toplam K/Z, ortalama
  süre, kapanış nedenleri, yönetimin katkısı (kurallarla vs vadeye kadar tutsan) ve açık fikirlerin güncel K/Z'si.
- **Model kalibrasyonu:** Aynı fikir vadeye kadar tutulmuş gibi dayanağın vade kapanışıyla sonuçlandırılır.
  Gerçekleşen kazanma oranı tahmini POP'la, K/Z tahmini EV'yle karşılaştırılır. Model kendini abartıyorsa →
  `OPT_TILT` / `OPT_DIR_TRUST` / ağırlıklar düşürülür. **Bu bir tahmin motorudur; karne onun ölçüsüdür.**

Değerleme kaynağı Yahoo'nun canlı zinciridir (gerçek alış/satış). Alpaca'nın ücretsiz opsiyon verisi "indicative"
(türetilmiş kotasyon, 15 dk gecikmeli işlem) olduğu için değerlemede kullanılmaz; geçmiş opsiyon mumları
(Şubat 2024'ten beri) ileride geriye dönük opsiyon testinde kullanılacak.

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
Ayarlar (env): `MIN_CONF`, `MIN_CONF_SAT`, `MIN_ADX`, `MIN_ADX_SAT`, `MAX_RSI_BUY`, `MIN_RSI_SAT`, `MIN_DVOL`,
`MAX_AL_DAY`, `MAX_SAT_DAY`, `CORE_N` · opsiyon: `OPT_MIN_EDGE`, `OPT_ACCOUNT`, `OPT_RISK`, `OPT_MIN_OI`,
`OPT_MAX_SPREAD`, `OPT_SLIP`, `OPT_TILT`, `OPT_DIR_TRUST`, `OPT_INV`, `OPT_INV_HARD`, `IV_TOP`.

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
