# پل MT5 + Apex و سرور آنلاین زرنگار

## حالت Online (بدون MT5)

```bash
python3 zarnegar_online.py
```

Endpointها همان قرارداد اپ هستند:

- `/v1/health`
- `/v1/market?symbol=XAUUSD`
- `/v1/bars?symbol=XAUUSD&timeframe=M5&count=300`
- `/v1/ai?symbol=XAUUSD`

فید زنده از Swissquote / Gold API / XAUS / CoinGecko / Yahoo GC=F خوانده می‌شود. AI اصلی **Apex Quant Fusion** است.

## حالت MT5 Bridge

این Bridge فقط داده بازار و خروجی AI را می‌خواند و هیچ endpoint برای ارسال سفارش ندارد.

```powershell
pip install -r requirements.txt
$env:ZARNEGAR_TOKEN="یک-توکن-طولانی-و-خصوصی"
python mt5_bridge.py
```

### مدل‌ها

- Apex Quant Fusion (همیشه، بدون وابستگی سنگین)
- Chronos-2 اختیاری: `pip install -r requirements-ai-chronos.txt`
- TimesFM 2.5 اختیاری طبق راهنمای Google Research

`strength_score` احتمال برد نیست.

```powershell
$env:ZARNEGAR_AI_PROVIDERS="apex,chronos2,timesfm25"
$env:ZARNEGAR_AI_HORIZON="6"
$env:ZARNEGAR_AI_CONTEXT="512"
$env:ZARNEGAR_AI_CACHE_SEC="20"
$env:ZARNEGAR_AI_FORCE_CPU="1"
```

## امنیت

- Bridge را روی اینترنت عمومی Port Forward نکنید.
- رمز MT5 داخل اپ Android وارد نمی‌شود.
- این Build فقط Shadow/Research است و معامله واقعی ارسال نمی‌کند.
