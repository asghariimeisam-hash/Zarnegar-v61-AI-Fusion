# تغییرات Zarnegar v61 AI Fusion

- افزودن AI Fusion با پشتیبانی از Chronos-2 و TimesFM 2.5
- Endpoint جدید `/v1/ai` در MT5 Bridge
- اجرای AI در Thread جدا از Market Polling برای جلوگیری از توقف Tick Feed
- Consensus Gate: اختلاف مدل‌ها = WAIT
- Regime Filter: Trend / Range
- AI Strength جدا از Win Rate و به‌عنوان probability نمایش داده نمی‌شود
- AI Freshness Gate و Minimum AI Strength قابل تنظیم
- ذخیره Snapshot خروجی AI همراه هر Signal/NO TRADE
- پنل جدید AI در Dashboard و Settings
- مهاجرت State از v59 به v61
- Real Order همچنان قفل و Bridge کاملاً Read-Only است
