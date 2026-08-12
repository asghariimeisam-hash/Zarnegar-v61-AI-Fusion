# Zarnegar v61 Apex — Online Institutional XAUUSD

نسخه Apex زرنگار: ترمینال زنده طلا + کمیته هوش مصنوعی ۸ میزه. سفارش واقعی ارسال نمی‌شود.

## چه چیزی آنلاین شد؟

حالت پیش‌فرض **Online Apex • Live Gold** است و بدون MetaTrader کار می‌کند:

1. **فید زنده XAUUSD** از Swissquote BBO، Gold API، XAUS و CoinGecko.
2. **Apex Quant Fusion** — هشت میز تخصصی (Trend, Momentum, Structure, Volatility, Liquidity, Mean-Revert, Session, Flow).
3. **وتوی اختلاف** — اگر Trend و Structure خلاف هم باشند یا اکثریت شکل نگیرد، خروجی `WAIT` است.
4. **Chronos-2 و TimesFM 2.5** همچنان بوستر اختیاری روی PC دارای MT5 هستند، نه پیش‌نیاز سیگنال.
5. **Auto Scan** فقط ستاپ A+ را در Shadow ثبت می‌کند.

> `AI Strength` احتمال برد نیست. Win Rate واقعی فقط از Shadow/Forward/Live ثبت‌شده محاسبه می‌شود. هدف ۹۰٪ Gate تحقیقاتی است، تضمین نیست.

## راه‌اندازی سریع (آنلاین)

```bash
python3 zarnegar_online.py
```

سپس مرورگر را روی `http://127.0.0.1:8080` باز کنید. اپ بلافاصله به فید زنده طلا وصل می‌شود.

ویندوز:

```bat
start_online.bat
```

## MT5 Bridge (اختیاری، دقیق‌تر برای حساب بروکر)

```powershell
pip install -r requirements.txt
$env:ZARNEGAR_TOKEN="یک-توکن-طولانی-و-خصوصی"
python mt5_bridge.py
```

در تنظیمات اپ:

- Feed Mode = `MT5 Bridge • Read Only`
- Bridge URL = IP کامپیوتر + پورت 8765
- Bearer Token = همان Token
- Apex Fusion = ON

Chronos-2 / TimesFM فقط اگر نصب باشند به کمیته اضافه می‌شوند. بدون آن‌ها Apex همچنان تصمیم می‌دهد.

## ساخت APK

پروژه را در Android Studio باز کنید:

`Build > Build APK(s)`

خروجی Debug: `app/build/outputs/apk/debug/app-debug.apk`

## امنیت

- هیچ `order_send` وجود ندارد.
- رمز MT5 داخل WebView ذخیره نمی‌شود.
- فید عمومی فقط از hostهای مجاز در لایه Native خوانده می‌شود.
