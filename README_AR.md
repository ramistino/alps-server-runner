# ALPS Runner Recovery Patch v1

هذه النسخة لا تغير الاستراتيجيات ولا منطق AHI/ARI. وظيفتها فقط حماية واسترجاع طبقة النتائج والتقارير.

## ماذا تضيف؟

- `STALE_FORWARD` إذا كان السيرفر RUNNING لكن آخر Forward Refresh قديم.
- حفظ Snapshot History في `recovery-state.json`.
- حفظ Previous / Current / Max Observed Ledger.
- إضافة `/runner/recovery` و `/runner/history`.
- إضافة قسم Recovery داخل `/runner/report.md`.
- Seed تاريخي من تقرير 19 يونيو: 2,294 paper signals / 1,128 closed / 455 wins / 673 losses.
- Auto safe reload/catch-up عند stale forward، بدون تغيير الاستراتيجيات.

## أهم endpoints

```text
/runner/health
/runner/report.md
/runner/recovery
/runner/history
/runner/export-recovery-state
```

## إعدادات مهمة في Render

يفضل إضافة Persistent Disk على Render ثم ضبط:

```text
ALPS_DATA_DIR=/data/alps
ALPS_REPORT_DIR=/data/alps/reports
ALPS_PROFILE_DIR=/data/alps/chromium-profile
```

إذا لم تضف Disk، سيعمل التصحيح، لكن الـ recovery-state قد يضيع مع إعادة deploy كاملة.

## طريقة الرفع من الهاتف

1. افتح GitHub repo: `ramistino/alps-server-runner`.
2. ارفع محتويات هذا الملف ZIP في جذر الريبو.
3. تأكد أن Render يستخدم Dockerfile من الجذر: `./Dockerfile`.
4. Deploy / Manual Deploy من Render.
5. بعد التشغيل افتح:

```text
https://alps-server-runner.onrender.com/runner/health
https://alps-server-runner.onrender.com/runner/recovery
```

## ما الذي يجب أن يظهر؟

- إذا كان forward قديمًا: `status: STALE_FORWARD`.
- إذا بدأ يتحرك: `forwardStatus: LIVE_FORWARD` أو `WAITING_FOR_FRESH_CANDLE`.
- في recovery: ستجد `previousNonZeroLedger` و `maxObserved`.

## مهم

هذا التصحيح لا يفتح صفقات حقيقية، لا يضيف قيود، ولا يوقف البحث. هو طبقة مراقبة وحفظ واستمرارية فقط.


## v1.1 Safe Boot
إذا فشل تشغيل Chromium، لن يسقط Render بالكامل. ستبقى روابط /runner/health و /runner/recovery تعمل وتعرض PAGE_LAUNCH_FAILED مع تفاصيل الخطأ.
