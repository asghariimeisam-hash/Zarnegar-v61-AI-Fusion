# Zarnegar v61 Personal XAUUSD — AI Fusion Edition

نسخه شخصی زرنگار برای XAUUSD با لایه پیش‌بینی پیشرفته و Shadow Validation.

## معماری AI

زرنگار v61 از یک معماری **Fusion** استفاده می‌کند، نه یک مدل واحد:

1. **Amazon Chronos-2** — مدل Foundation برای پیش‌بینی سری زمانی.
2. **Google TimesFM 2.5** — مدل Foundation دوم برای تنوع پیش‌بینی.
3. **MTF Technical Engine** — H1/M15/M5، EMA، RSI، ATR، Structure و Spread.
4. **Regime Filter** — تشخیص Trend/Range و جلوگیری از اجبار به معامله.
5. **Consensus Gate** — اگر مدل‌ها اختلاف داشته باشند یا با جهت تکنیکال هم‌جهت نباشند، خروجی `WAIT / NO TRADE` می‌شود.

> `AI Strength` احتمال برد نیست. Win Rate واقعی فقط از Shadow/Forward/Live ثبت‌شده محاسبه می‌شود.

## امنیت و اجرا

- Bridge روی PC دارای MetaTrader 5 اجرا می‌شود.
- رمز MT5 داخل WebView یا JavaScript ذخیره نمی‌شود.
- API با Bearer Token محافظت می‌شود.
- endpoint هوش مصنوعی فقط پیش‌بینی می‌دهد.
- این Build **هیچ `order_send` یا endpoint اجرای معامله واقعی ندارد**.

## راه‌اندازی سریع

### 1) پایه MT5 Bridge

در پوشه `bridge`:

```powershell
pip install -r requirements.txt
```

### 2) Chronos-2

```powershell
pip install -r requirements-ai-chronos.txt
```

### 3) TimesFM 2.5

TimesFM را طبق راهنمای رسمی Google Research با PyTorch نصب کنید. اگر نصب نباشد، Bridge با Chronos-2 به حالت `PARTIAL` ادامه می‌دهد. اگر هیچ مدل Foundation در دسترس نباشد، AI تصمیم معاملاتی صادر نمی‌کند و حالت `DEGRADED / WAIT` می‌دهد.

### 4) اجرای Bridge

```powershell
$env:ZARNEGAR_TOKEN="یک-توکن-طولانی-و-خصوصی"
python mt5_bridge.py
```

سپس در اپ:

- Feed Mode = `MT5 Bridge • Read Only`
- Bridge URL = IP کامپیوتر + پورت 8765
- Bearer Token = همان Token
- AI Fusion = ON

## ساخت APK

پروژه را در Android Studio باز کنید و:

`Build > Build APK(s)`

یا از Workflow آماده GitHub Actions استفاده کنید. خروجی Debug:

`app/build/outputs/apk/debug/app-debug.apk`

## Validation

هدف 90% فقط Gate تحقیقاتی است و تضمین نیست. قبل از هر Live Trading باید نمونه Shadow کافی، Win Rate، Profit Factor و Drawdown واقعی بررسی شوند.
