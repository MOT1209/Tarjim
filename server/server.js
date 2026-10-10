// server/server.js — الخادم الرئيسي لأداة الترجمة AraLink
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { createStore, closeAll: closeStore } = require('./store');
const translateRouter = require('./routes-translate');
const ttsRouter = require('./routes-tts');
const videoRouter = require('./routes-video');
const settingsRouter = require('./routes-settings'); // إعدادات المفاتيح (.env) — محمي بـ ADMIN_TOKEN
const statsRouter = require('./routes-stats'); // إحصائيات لوحة التحكم — محمية بـ ADMIN_TOKEN
const { requireAdmin, tokenMatches, adminCookieHeader } = require('./adminAuth');
const { getAllLanguages } = require('./languages');

const app = express();

// trust proxy: في الإنتاج فقط (خلف بروكسي Render) حتى يعكس req.ip عنوان الزائر الحقيقي
// ويبقى حد الطلبات لكل IP فعّالًا. محليًا يبقى معطّلًا فيُستخدم عنوان المقبس الحقيقي.
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

// ===== وسيطات عامة =====
// CORS allowlist (CORS_ORIGIN in .env). Empty = same-origin only:
// no Origin header -> pass through without CORS headers; allowed origin or '*' -> reflected; others rejected.
function corsOrigin(origin, callback) {
  const allowed = (config.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin) return callback(null, false); // no Origin header -> pass through without CORS headers
  callback(null, allowed.includes('*') || allowed.includes(origin));
}
app.use(cors({ origin: corsOrigin }));

// ===== ترويسات الأمان (helmet) =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\'', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ['\'self\'', '\'unsafe-inline\'', 'https://fonts.googleapis.com'],
      fontSrc: ['\'self\'', 'https://fonts.gstatic.com'],
      imgSrc: ['\'self\'', 'data:', 'blob:'],
      mediaSrc: ['\'self\'', 'blob:', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      frameSrc: ['\'self\'', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc: ['\'self\''],
    },
  },
}));

// ===== مفتاح API اختياري للطلاب (ARALINK_API_KEY في .env) =====
// إن ضُبط: الطلبات التي تحمل المفتاح الصحيح تحصل على حد أعلى (×3)
// إن لم يُضبط: الخدمة مفتوحة بحد عام واحد (الوضع الحالي — مناسب للمضيافات المجانية)
const ARALINK_API_KEY = process.env.ARALINK_API_KEY || '';
let warnedApiKeyInQuery = false; // تحذير لمرة واحدة فقط دون كشف قيمة المفتاح
function isApiKeyValid(req) {
  if (!ARALINK_API_KEY) return false;
  // الأمان: المفتاح يُقبل من ترويسة x-api-key فقط؛ أي api_key في مسار query
  // يُتجاهل ولا يُعتدّ به كمصادقة لأنه يظهر في سجلات الخادم وسجل المتصفح وReferrer.
  if (req.query && req.query.api_key !== undefined && !warnedApiKeyInQuery) {
    warnedApiKeyInQuery = true;
    console.warn('[api-key] request used disallowed ?api_key= query param — header x-api-key only.');
  }
  const k = req.headers['x-api-key'];
  // مقارنة ثابتة الزمن (timing-safe) — التقييم المباشر بـ === يكشف طول/حروف المفتاح
  // عبر زمن الاستجابة ويسمح لهجمات القياس الزمني. tokenMatches تستخدم timingSafeEqual.
  return tokenMatches(k, ARALINK_API_KEY);
}

// ===== حد الطلبات =====
// يمنع استنزاف حصص الترجمة المجانية عبر إساءة استخدام واجهة API.
// العدّادات تمرّ عبر server/store.js: ذاكرة داخل العملية افتراضيًا، أو Redis
// مشترك عند ضبط REDIS_URL (لازم عند تشغيل أكثر من نسخة خادم). فشل المتجر
// = سقوط تلقائي للذاكرة + السماح بالطلب (fail-open) فلا ينهار الخادم.
function createRateLimiter({ windowMs, max, keyedMultiplier = 3 }) {
  const store = createStore();

  return async (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = isApiKeyValid(req) ? max * keyedMultiplier : max;
    try {
      const { count, resetAt } = await store.incr(ip, windowMs);
      // ترويسات X-RateLimit — تُرسَل دائمًا قبل فحص الحد حتى يعرف العميل وضعه
      const resetSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.setHeader('X-RateLimit-Reset', String(resetSec));
      if (count > limit) {
        res.setHeader('Retry-After', resetSec);
        return res.status(429).json({ error: 'rate-limited' });
      }
    } catch (e) {
      console.error('[rate-limit] store error — allowing request:', e && e.message);
    }
    next();
  };
}

const translateLimiter = createRateLimiter({ windowMs: config.RATE_LIMIT_WINDOW_MS, max: config.RATE_LIMIT_MAX });
const heavyLimiter = createRateLimiter({ windowMs: config.RATE_LIMIT_WINDOW_MS, max: config.RATE_LIMIT_MAX_HEAVY });

// ===== خط الأساس: حد طلبات يغطي /api كاملًا =====
// مهم: Express يطابق app.use على حدود المقاطع، لذا '/api/translate' لا يغطي
// '/api/translate-smart'. هذا الأساس يغطي كل مسار تحت /api بلا استثناء،
// والحدود الأشد أدناه تُركَّب فوقه (كلاهما يُحتسب).
app.use('/api', translateLimiter);

// مسارات الملفات (استيراد/تصدير) — قبل express.json العام لأن لها حد جسم 15mb خاصًا بها،
// وبعد خط الأساس أعلاه حتى لا تفلت من حد الطلبات.
app.use('/api/translate-file', heavyLimiter);
app.use('/api/export', heavyLimiter);
app.use('/api', require('./routes-file'));

// الفيديو المحلي — قبل express.json العام أيضًا: جسمه base64 يصل 60mb، وحدّ الـ2mb
// العام كان يرفضه قبل بلوغ المعالج، فيبقى MAX_BASE64=40MB كودًا ميتًا والميزة
// مقيّدة عمليًا بـ2mb.
app.use('/api/video-local', heavyLimiter);
app.use('/api', require('./routes-local-video'));

// OCR — قبل express.json العام لأن له حد جسم 15mb خاصًا به (الصور الكبيرة),
// وبما أن routes-ocr يُركِّب express.json({limit:'15mb'}) بدلًا من 2mb العام.
app.use('/api/ocr', heavyLimiter);
app.use('/api', require('./routes-ocr'));

app.use(express.json({ limit: '2mb' }));

// ===== بثّ الترجمة عبر SSE — قبل compression عمدًا =====
// الموضع ليس اعتباطيًا: يحتاج req.body (بعد express.json)، ويجب أن يسبق
// compression لأن 'text/event-stream' نوع قابل للضغط، فيخزّن الضاغط الأحداث
// مؤقتًا وتصل الترجمة دفعة واحدة في النهاية — أي يعمل الطلب ويضيع البثّ صامتًا.
// حد الطلبات مغطّى بخط الأساس على '/api' أعلاه (مطابق لـ /api/translate).
app.use('/api', require('./routes-sse'));

// ===== دبلجة يوتيوب إلى MP4 (jobs + SSE progress) — قبل compression عمدًا (نفس سبب routes-sse) =====
// الحدّان أدناه **يجب** أن يسبقا هذا الموجّه: كان تركيبهما بعده (مع routes-dub
// وroutes-youtube) يعني أنهما لا يُنفَّذان إطلاقًا لهذه المسارات، لأن الموجّه
// هنا ينهي الطلب قبل بلوغهما — فكانت الدبلجة (أثقل عملية في المشروع) تحت الحد
// العام وحده. tests/middlewareOrder.test.js يحرس هذا الترتيب الآن.
const dubLimiter = createRateLimiter({ windowMs: config.RATE_LIMIT_WINDOW_MS, max: config.RATE_LIMIT_MAX_DUB });
app.use('/api/dub', dubLimiter);
app.use('/api/youtube', heavyLimiter);
app.use('/api', require('./routes-youtube-dub'));

// ===== متابعة الوظائف — قبل compression عمدًا للسبب نفسه =====
// '/api/jobs/:id/stream' بثّ SSE، والضاغط يخزّنه فيصل دفعة واحدة في النهاية.
app.use('/api', require('./routes-jobs'));

// ===== ضغط الاستجابات (يقلل حجم HTML/CSS/JS/JSON 60-80%) =====
app.use(compression());

// ===== الملفات الثابتة (الواجهة فقط — لا يُنشر جذر المشروع) =====
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ===== توثيق API (OpenAPI + Swagger UI) — اختياري عبر SWAGGER_ENABLED=true =====
// بلا تبعية جديدة: docs/openapi.json يُقرأ مرة واحدة عند الإقلاع، وواجهة Swagger
// تُحمَّل من CDN (مسموح في CSP سلفًا للسكربتات). المعطّل افتراضيًا كي لا يفضح
// خريطة المسارات كاملة على نشر عام دون طلب.
if (process.env.SWAGGER_ENABLED === 'true') {
  let swaggerSpec = null;
  try {
    swaggerSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'));
  } catch (e) {
    console.warn('[docs] SWAGGER_ENABLED لكن docs/openapi.json غير مقروء:', e.message);
  }
  if (swaggerSpec) {
    app.get('/api/docs/swagger.json', (req, res) => res.json(swaggerSpec));
    app.get('/api/docs', (req, res) => {
      res.type('html').send(`<!doctype html>
<html lang=\"ar\" dir=\"rtl\">
<head>
  <meta charset=\"utf-8\">
  <title>AraLink API — التوثيق</title>
  <link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css\">
</head>
<body>
  <div id=\"swagger\"></div>
  <script src=\"https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js\"><\/script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/api/docs/swagger.json', dom_id: '#swagger' });
  <\/script>
</body>
</html>`);
    });
  }
}

// ===== فحص الصحة =====
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'aralink', time: new Date().toISOString() });
});

// ===== قائمة اللغات المدعومة =====
app.get('/api/languages', (req, res) => {
  res.json({ languages: getAllLanguages() });
});

// ===== دخول الأدمن — كوكي httpOnly بدل localStorage =====
// كانت اللوحة تحفظ التوكن في localStorage، فأي XSS يقرأه ويسرّبه (دين §8.6).
// الآن يُبادَل التوكن مرة واحدة بكوكي httpOnly لا يراه جافاسكربت إطلاقًا.
// المنطق نفسه في adminAuth.js يخدم الرأس والكوكي معًا.
//
// ===== قفل محاولات الفشل المتتالية (فوق heavyLimiter) =====
// heavyLimiter يحد إجمالي الطلبات (افتراضيًا 10/دقيقة) لكنه لا يمنع تخمين
// ADMIN_TOKEN الموزَّع ببطء. هذا العدّاد يراقب الفشل المتتالي لكل IP:
//   - 5 محاولات فاشلة  → 429 مع Retry-After: 60  (قفل قصير)
//   - 10 محاولات فاشلة → 429 مع Retry-After: 900 (قفل 15 دقيقة)
// والنجاح يصفّر العدّاد. نافذتان مستقلتان لأن store.incr(key, windowMs) لا يمدّد
// الانتهاء عند الزيادة — فلا يمكن تبديل نافذة نفس المفتاح بعد بدء العد.
const loginFailStore = createStore();
const LOGIN_SOFT_MS = 60000;      // نافذة القفل القصير (60 ثانية)
const LOGIN_HARD_MS = 15 * 60000; // نافذة القفل الشديد (15 دقيقة)
const LOGIN_SOFT_LIMIT = 5;
const LOGIN_HARD_LIMIT = 10;

// يزيد عدّادي الفشل ويقرر القفل. يُعيد { retryAfter } للقفل أو null للمتابعة
// أو { storeError: true } عند تعذّر العدّ (fail-closed: مسار الأدمن يُغلق
// بـ 503 بدل السماح بلا قفل — عكس سياسة fail-open في حد الطلبات العام، لأن
// انقطاع Redis هنا كان يعني طريقًا مفتوحًا لتخمين ADMIN_TOKEN).
// ملاحظة: مفتاحا النافذتين مستقلّان — لو اشتركا في مفتاح واحد، كان incr الثاني
// يزيد نفس مدخلة الأول فيحسب كل محاولة مرتين ويحمل resetAt النافذة القصيرة.
// المعامل الثاني للحقن في الاختبارات فقط (الافتراضي مخزن القفل المشترك).
async function checkLoginLock(req, store = loginFailStore) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const softKey = `login-fail:s:${ip}`; // عدّاد النافذة القصيرة (60 ثانية)
  const hardKey = `login-fail:h:${ip}`; // عدّاد النافذة الشديدة (15 دقيقة)
  let soft, hard;
  try {
    [soft, hard] = await Promise.all([
      store.incr(softKey, LOGIN_SOFT_MS),
      store.incr(hardKey, LOGIN_HARD_MS),
    ]);
  } catch (e) {
    console.error('[admin-login] lockout store failed — rejecting attempt:', e && e.message);
    return { storeError: true };
  }
  if (hard.count >= LOGIN_HARD_LIMIT) {
    return { retryAfter: Math.max(1, Math.ceil((hard.resetAt - Date.now()) / 1000)) };
  }
  if (soft.count >= LOGIN_SOFT_LIMIT) {
    return { retryAfter: Math.max(1, Math.ceil((soft.resetAt - Date.now()) / 1000)) };
  }
  return null;
}

app.post('/api/admin/login', heavyLimiter, async (req, res) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'settings-disabled' });
  try {
    const lock = await checkLoginLock(req);
    if (lock && lock.storeError) {
      return res.status(503).json({ error: 'service-unavailable' });
    }
    if (lock) {
      res.setHeader('Retry-After', String(lock.retryAfter));
      return res.status(429).json({ error: 'rate-limited' });
    }
    const given = (req.body && req.body.token) || req.get('x-admin-token') || '';
    if (!tokenMatches(given, expected)) return res.status(401).json({ error: 'unauthorized' });
    // نجاح: تصفير عدّادي الفشل (النافذتان معًا) — لا قفل لمن دخل بنجاح
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    loginFailStore.reset(`login-fail:s:${ip}`).catch(() => {});
    loginFailStore.reset(`login-fail:h:${ip}`).catch(() => {});
    res.setHeader('Set-Cookie', adminCookieHeader(given));
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-login] unexpected:', e);
    res.status(500).json({ error: 'server-error' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', adminCookieHeader('', { clear: true }));
  res.json({ ok: true });
});

// ===== إعدادات المفاتيح (قراءة/حفظ .env) — محمية بـ ADMIN_TOKEN =====
// الافتراضي الآمن: بلا ADMIN_TOKEN ⇒ المسار معطّل بالكامل (503).
// يشمل GET أيضًا لأنه يكشف hasGeminiKey — استطلاع مفيد للمهاجم.
// ملاحظة: ARALINK_API_KEY مفتاح حصص للطلاب ولا يصلح هنا — لا يجوز أن يمنح
// مفتاحُ حصةٍ صلاحيةَ الكتابة في .env.
app.use('/api/settings', heavyLimiter, requireAdmin, settingsRouter);

// ===== إحصائيات لوحة التحكم (محمية بـ ADMIN_TOKEN + حد أثقل) =====
app.use('/api/stats', heavyLimiter, requireAdmin, statsRouter);

// ===== مسارات الترجمة (حد أساسي مطبّق أعلاه على /api كامل) =====
app.use('/api', translateRouter);

// ===== مسارات تحويل النص إلى صوت (حد أثقل — طلبات مكلفة) =====
app.use('/api/tts', heavyLimiter);
app.use('/api', ttsRouter);

// ===== الدبلجة (حدّ خاص أوسع — دفعات متتابعة طوال الفيديو لا طلب واحد) =====
// الحدّ نفسه مركَّب أعلاه قبل routes-youtube-dub ويغطّي هذا الموجّه أيضًا
// (app.use على بادئة يسري على كل ما بعده)، فلا يُكرَّر هنا حتى لا يُحتسب مرتين.
app.use('/api', require('./routes-dub'));

// ===== المشاريع (البند 30) — تحت الحد الأثقل: الرفع يكتب على القرص =====
app.use('/api/projects', heavyLimiter);
app.use('/api', require('./routes-projects'));

// ===== نظام الوكلاء (الموجة 1) — التشغيل عمل ثقيل يمرّ عبر محرك الوظائف =====
// الوكلاء يعملون في طابور (agentRunner) بسقف التزامن المشترك، فالحد الأثقل
// مطلوب هنا كما في بقية الأنظمة المكلفة (TTs والفيديو والمشاريع).
app.use('/api/agents', heavyLimiter);
app.use('/api', require('./routes-agents'));

// ===== بيانات يوتيوب الوصفية (الواجهة الرسمية — المسار المتوافق) =====
// طلب خفيف (وحدة واحدة من حصة يوتيوب) لكنه يستهلك حصة خارجية، فيبقى تحت الحد
// الأثقل — المركَّب أعلاه قبل routes-youtube-dub ويغطّي هذا الموجّه أيضًا.
app.use('/api', require('./routes-youtube'));

// ===== مسارات بثّ الفيديو (الترجمات المدمجة) =====
app.use('/api/video', heavyLimiter);
app.use('/api', videoRouter);

// ===== الموجة 2: تشكيل عربي (المكوّنات المكلفة الأخرى — OCR والفيديو المحلي — أُعيدت قبل express.json) =====
app.use('/api/tashkeel', heavyLimiter);
app.use('/api', require('./routes-tashkeel'));

// ===== معالجة الأخطاء العامة =====
app.use((err, req, res, _next) => {
  // أخطاء المحلل (body-parser) تحمل status/statusCode صحيحًا، وكان ابتلاعها في
  // 500 يخفي السبب الحقيقي: تجاوز الحجم كان يظهر «خطأ خادم» بدل 413.
  const status = err && (err.status || err.statusCode);
  if (status === 413) {
    return res.status(413).json({ error: 'input-too-large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid-json' });
  }
  console.error('[server] unhandled:', err);
  res.status(500).json({ error: 'server-error' });
});

// ===== تشغيل الخادم =====
if (require.main === module) {
  // تحذير أمني صامت لا يمنع التشغيل: ADMIN_TOKEN قصير (أقل من 16 حرفًا) يسهل
  // تخمينه ببعض المحاولات ويفتح إعدادات المفاتيح (routes-settings) ولوحة الإحصائيات.
  // لا نفرض حدًا لأن فرضه يكسر النشرات القائمة؛ ننبّه فقط لتغييره.
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (adminToken && adminToken.length < 16) {
    console.warn('⚠️  ADMIN_TOKEN قصير (< 16 حرفًا). مسارات /api/settings و /api/stats محمية به — يُنصح بمفتاح أطول.');
  }

  const server = app.listen(config.PORT, () => {
    console.log(`🚀 AraLink يعمل على http://localhost:${config.PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ المنفذ ${config.PORT} مستخدم من تطبيق آخر.`);
      console.error('   جرّب منفذًا مختلفًا:  PORT=3999 npm run dev');
      process.exit(1);
    }
    throw err;
  });

  // إغلاق اتصال Redis المشترك (إن وُجد) عند الإيقاف — بلا Redis لا شيء يحدث
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { closeStore().catch(() => {}); });
  }
}

module.exports = app;
module.exports.createRateLimiter = createRateLimiter; // للاختبار المباشر (وحدة بلا شبكة)
module.exports.checkLoginLock = checkLoginLock; // للاختبار المباشر (حقن مخزن يرمي)
module.exports.closeStore = closeStore;
