# پل MT5 + AI زرنگار v61

این Bridge فقط **داده بازار و خروجی AI را می‌خواند/تولید می‌کند** و هیچ endpoint برای ارسال سفارش ندارد.

## Endpointها

- `/v1/health`
- `/v1/market?symbol=XAUUSD`
- `/v1/bars?symbol=XAUUSD&timeframe=M5&count=300`
- `/v1/ai?symbol=XAUUSD`

## مدل‌های AI

- Chronos-2 به‌عنوان Foundation Forecaster اول
- TimesFM 2.5 به‌عنوان Foundation Forecaster دوم
- Regime/MTF engine برای فیلتر شرایط بازار
- Consensus: اختلاف مدل‌ها باعث `WAIT` می‌شود

`strength_score` احتمال برد نیست؛ فقط قدرت و هم‌جهتی forecast را خلاصه می‌کند.

## راه‌اندازی روی ویندوز

1. MetaTrader 5 را نصب کنید و وارد حساب بروکر خود شوید.
2. Python 3 را نصب کنید.
3. در پوشه `bridge` اجرا کنید:

```powershell
pip install -r requirements.txt
pip install -r requirements-ai-chronos.txt
$env:ZARNEGAR_TOKEN="یک-توکن-طولانی-و-خصوصی"
python mt5_bridge.py
```

برای TimesFM 2.5، مخزن رسمی Google Research TimesFM را با extra مربوط به PyTorch نصب کنید. Bridge ماژول `timesfm` را خودکار تشخیص می‌دهد.

## تنظیمات اختیاری

```powershell
$env:ZARNEGAR_AI_PROVIDERS="chronos2,timesfm25"
$env:ZARNEGAR_AI_HORIZON="6"
$env:ZARNEGAR_AI_CONTEXT="512"
$env:ZARNEGAR_AI_CACHE_SEC="30"
# برای سیستم بدون GPU:
$env:ZARNEGAR_AI_FORCE_CPU="1"
```

## نکات امنیتی

- Bridge را روی اینترنت عمومی Port Forward نکنید.
- برای اتصال خارج از LAN از VPN خصوصی یا HTTPS امن استفاده کنید.
- رمز MT5 داخل اپ Android وارد نمی‌شود.
- اولین اجرای مدل ممکن است برای دریافت وزن‌های مدل زمان‌بر باشد؛ بعد از Cache سریع‌تر می‌شود.
- این Build فقط Shadow/Research است و معامله واقعی ارسال نمی‌کند.
