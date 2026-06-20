# إصلاح Render Runner v9.1.7

هذا الإصلاح يحتوي على تعديلين تراكميين على `runner.js`:

## 1. إصلاح `START_LAB` destructuring (السابق)
كان `ensureStarted()` بيستدعي `page.evaluate` بدون تمرير `opts`، فيحصل خطأ:
`Cannot destructure property 'START_LAB' of 'undefined'`

تم الإصلاح بتمرير `{ START_LAB, START_FORWARD }` كـ argument ثالث حقيقي لـ
`evaluateSafe`، مع قراءة آمنة `(opts = {})` داخل الصفحة بدل التفكيك المباشر.

## 2. إصلاح تكرار query string في الرابط (جديد)
كانت بيئة Render فيها `APP_URL` مضبوطة بالفعل على رابط فيه
`?renderRunner=1&v=918-evidence-driven`. بعدين `cleanUrl()` كانت بتلصق
`?renderRunner=1&v=917-ahi-core-render` فوقها بدون التأكد من وجود `?` أصلاً،
فينتج رابط مكسور بعلامتي استفهام:

```
https://...netlify.app/?renderRunner=1&v=918-evidence-driven/?renderRunner=1&v=917-ahi-core-render
```

**الإصلاح:**
- `APP_URL` نفسها الآن تُنظَّف من أي query string أو hash عند القراءة من
  متغيرات البيئة، فتظهر نظيفة في endpoint الصحة (`/runner/health`) وفي اللوج.
- `cleanUrl()` بقت بتشيل أي `?...` أو `#...` موجود في الرابط الأساسي قبل ما
  تضيف الباراميترات الخاصة بالـ runner، فمستحيل يتكرر الـ query string تاني
  بغض النظر عن شكل `APP_URL` في بيئة Render.

تم اختبار الإصلاح فعلياً بالقيمة الحقيقية اللي ظهرت في تقرير الإنتاج
(`https://clever-duckanoo-f102c0.netlify.app/?renderRunner=1&v=918-evidence-driven`)
والنتيجة رابط نظيف:
`https://clever-duckanoo-f102c0.netlify.app/?renderRunner=1&v=917-ahi-core-render`

## التطبيق
استبدل `runner.js` في repo `ramistino/alps-server-runner` على GitHub بهذا الملف،
ثم اعمل Deploy للـ commit الأحدث على Render. لا حاجة لتغيير أي environment
variable يدوياً — الإصلاح بيتعامل مع القيمة الحالية تلقائياً.
