// tests/smoke.test.js — اختبار الدخان: كل مسار تطلبه الواجهة له راوتر مركَّب
//
// لماذا: راوتر SSE بقي غير مركَّب في server.js من الموجة 3 حتى اكتُشف يدويًا،
// فكانت الترجمة معطّلة كليًا في المتصفح بينما 248 اختبار وحدة تمرّ. السبب أن
// كل الاختبارات كانت تفحص وحدات معزولة، ولا شيء يفحص «هل التطبيق مُركَّب
// كما تتوقعه الواجهة؟».
//
// هذا الملف يسدّ تلك الفجوة بطريقتين:
//   1) قائمة صريحة بالمسارات الحرجة — لا يجوز أن يعيد أيٌّ منها 404.
//   2) استخراج آلي لكل '/api/...' مذكور في public/js/*.js والتأكد أن له راوترًا.
//      فأي مسار جديد تستدعيه الواجهة بلا تركيب في الخادم يكسر الاختبار فورًا.
//
// لا شبكة: كل ما يهمّ هنا هو «ليس 404»، لا صحة الاستجابة.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.RATE_LIMIT_MAX = '10000';
process.env.RATE_LIMIT_MAX_HEAVY = '10000';
process.env.CACHE_FILE = path.join(os.tmpdir(), 'aralink-test-smoke-' + Date.now() + '.json');
process.env.ADMIN_TOKEN = 'smoke-admin-token';

const app = require('../server/server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// المسارات الحرجة: [method, path]
const CRITICAL = [
  ['POST', '/api/translate'],
  ['POST', '/api/translate-text'],
  ['POST', '/api/translate-stream'], // ← الذي سقط سهوًا
  ['POST', '/api/translate-file'],
  ['POST', '/api/translate-smart'],
  ['POST', '/api/export'],
  ['POST', '/api/tts'],
  ['POST', '/api/tashkeel'],
  ['POST', '/api/ocr'],
  ['POST', '/api/srt'],
  ['GET', '/api/health'],
  ['GET', '/api/languages'],
  ['GET', '/api/providers'],
  ['GET', '/api/stats/summary'],
  ['GET', '/api/stats/quality'],
  ['GET', '/api/stats/cost'],
  ['PATCH', '/api/dub/projects/p-test/segments/0'],
  ['POST', '/api/agents/run'], // ← الموجة 1: بوابة تشغيل الوكلاء
];

async function hit(method, route) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN },
    body: method === 'GET' ? undefined : JSON.stringify({}),
  });
}

for (const [method, route] of CRITICAL) {
  test(`${method} ${route} مركَّب (ليس 404)`, async () => {
    const res = await hit(method, route);
    assert.notEqual(
      res.status, 404,
      `${route} يعيد 404 — الراوتر غير مركَّب في server.js`,
    );
  });
}

test('الصفحة الرئيسية وملفات الواجهة تُخدَم', async () => {
  for (const asset of ['/', '/index.html', '/style.css', '/js/app.js', '/admin.html', '/manifest.webmanifest', '/sw.js']) {
    const res = await fetch(`${baseUrl}${asset}`);
    assert.equal(res.status, 200, `${asset} لا يُخدَم (${res.status})`);
  }
});

test('ملفات الاكتشاف تُخدَم (robots/sitemap/llms)', async () => {
  const robots = await fetch(`${baseUrl}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \/admin\.html/);
  assert.equal((await fetch(`${baseUrl}/sitemap.xml`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/llms.txt`)).status, 200);
});

// ===== الحارس الآلي =====
// يقارن المسارات التي تناديها الواجهة بالمسارات المسجَّلة فعلاً في تطبيق
// Express. التأمّل هنا أدقّ من استقصاء HTTP: يميّز «الراوتر غير مركَّب» عن
// «مركَّب لكن هذا المقطع الفرعي غير موجود»، ولا يحتاج طلبات شبكة.

// استخراج كل المسارات المسجَّلة من مكدّس الراوترات، مع بادئات التركيب
function mountPath(layer) {
  const src = layer.regexp && layer.regexp.source;
  if (!src || src === '^\\/?$') return '';
  // شكل بادئة Express: ^\/api\/stats\/?(?=\/|$)
  return src.replace(/^\^/, '').replace(/\\\/\?\(\?=.*$/, '').replace(/\\(.)/g, '$1');
}

function registeredRoutes(expressApp) {
  const found = new Set();
  (function walk(stack, prefix) {
    for (const l of stack) {
      if (l.route) found.add(prefix + l.route.path);
      else if (l.name === 'router' && l.handle && l.handle.stack) walk(l.handle.stack, prefix + mountPath(l));
    }
  })(expressApp._router.stack, '');
  return [...found];
}

// المسارات التي تناديها الواجهة
function frontendRoutes() {
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  const out = new Set();
  for (const file of fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
    for (const m of src.matchAll(/['"`](\/api\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?)/g)) out.add(m[1]);
  }
  return out;
}

// توحيد الشرطة الطرفية: راوتر مركَّب على '/api/settings' بمسار '/' يُسجَّل
// كـ '/api/settings/' بينما الواجهة تناديه بلا شرطة — والاثنان نفس المسار.
const trim = (r) => (r.length > 1 ? r.replace(/\/+$/, '') : r);

test('كل مسار /api تستدعيه الواجهة مسجَّل في الخادم', () => {
  const registered = registeredRoutes(app).map(trim);
  const wanted = frontendRoutes();
  assert.ok(wanted.size >= 8, `استخرجنا ${wanted.size} مسارًا فقط — تحقّق من التعبير النمطي`);
  assert.ok(registered.length >= 15, `سُجّل ${registered.length} مسارًا فقط — تحقّق من التأمّل`);

  const missing = [];
  for (const route of wanted) {
    const r = trim(route);
    // مطابقة تامة، أو بادئة يقع تحتها مسار مسجَّل — تغطّي المقاطع الديناميكية
    // سواء بُنيت بقالب (`/api/stats/${x}`) أو بتسلسل ('/api/video/' + id).
    const ok = registered.includes(r) || registered.some((x) => x.startsWith(r + '/'));
    if (!ok) missing.push(route);
  }
  assert.deepEqual(
    missing, [],
    `الواجهة تنادي مسارات غير مسجَّلة في server.js: ${missing.join(', ')}`,
  );
});
