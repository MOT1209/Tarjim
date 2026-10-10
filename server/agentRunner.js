// server/agentRunner.js — جسر الخادم إلى نظام الوكلاء (agents/) كوظيفة مقيَّدة
//
// لماذا هذا الملف؟ نظام الوكلاء (agents/) أداة CLI، وبوابة HTTP تحتاجه تعمل
// داخل محرك الوظائف المشترك (server/jobs) لتُرث سقف التزامن والتقدّم والإلغاء
// تمامًا كما في projectPipeline.js (projects/) وroutes-local-video.js. من دون
// هذا الجسر كان طلب HTTP واحد يحرق دورة المعالج بلا حدّ، ولا توجد متابعة ولا إلغاء.
//
// القاعدة الحمراء: لا اعتماد دائري — نستورد الطابور (singleton) والمرجع
// المركزي (server/agents/policy) والمنسّق (agents/core/orchestrator) فقط.
// أي استيراد لوحدة مسارات (routes-*.js) سيُدخلنا في حلقة: المسارات تستوردنا
// ونحن نستورد المسارات.
const jobs = require('./jobs'); // طابور التطبيق المشترك (jobs/index.js — نسخة واحدة)
const policy = require('./agents/policy'); // حوكمة التشغيل: فئة معروفة؟ معرّف موجود؟
const { Orchestrator } = require('../agents/core/orchestrator'); // منسّق الـ 300 وكيل

const JOB_TYPE = 'agent-task';
const MAX_RUNS = 100; // سجلّ التشغيلات: لا نُبقي أكثر من هذا في الذاكرة

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// ═══════════════════════════════════════════════════════════
// سجلّ التشغيلات — Map في الذاكرة (بلا قاعدة بيانات: البيانات تشغيلية
// عابرة، ولوحة الأدمن تريد «الآن» لا الأرشيف)
// ═══════════════════════════════════════════════════════════
const runsMap = new Map(); // jobId → سجل تشغيل

// منع نموّ الذاكرة بلا حدود: حين يتجاوز السجلّ سقفًا مريحًا نُسقط الأقدم.
// الأحدث أولًا في runs()؛ الأقدم هنا هو صاحب أقدم createdAt.
function evictOldest() {
  const cap = MAX_RUNS * 1.5;
  while (runsMap.size > cap) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [jobId, rec] of runsMap) {
      if ((rec.createdAt || 0) < oldestAt) {
        oldestAt = rec.createdAt || 0;
        oldestId = jobId;
      }
    }
    if (!oldestId) break;
    runsMap.delete(oldestId);
  }
}

// ═══════════════════════════════════════════════════════════
// ملخّص النتيجة — { runId, ok, files, detail } حيث detail سطر قصير.
// صيغ المنسّق الثلاث مختلفة (وكيل/فرقة/سير عمل)، فلكل فرعها الخاص.
// ═══════════════════════════════════════════════════════════
function buildSummary(kind, result, requestedId) {
  const r = result || {};
  const summary = { runId: r.runId || null, ok: false, files: [], detail: '' };

  if (kind === 'agent') {
    const main = r.main || {};
    const subs = r.subs || [];
    const ok = Boolean(main.ok) && subs.every((s) => s && s.ok);
    summary.ok = ok;
    summary.files = [main.file, ...subs.map((s) => s && s.file)].filter(Boolean);
    summary.detail = `${r.agent || requestedId}: ${ok ? 'نجح' : 'فشل'} (${subs.length + 1} وكلاء، ${main.ms || 0}ms)`;
  } else if (kind === 'squad') {
    const ok = r.okLeaders === r.leaders && typeof r.leaders === 'number';
    summary.ok = ok;
    summary.files = (r.results || []).flatMap((x) => {
      const files = [x && x.main && x.main.file];
      for (const s of (x && x.subs) || []) files.push(s && s.file);
      return files;
    }).filter(Boolean);
    summary.detail = `${r.squad || requestedId}: ${r.okLeaders || 0}/${r.leaders || 0} قادة ناجحون`;
  } else {
    summary.ok = !r.error;
    summary.detail = `workflow ${r.workflow || requestedId}: ${r.waves || 0} موجات في ${r.sec || 0} ثانية`;
  }
  return summary;
}

// ═══════════════════════════════════════════════════════════
// معالج الوظيفة — يُسجَّل في الطابور تحت JOB_TYPE (عقد register).
// يعمل داخل نفس سقف التزامن والتقدّم والإلغاء.
// ═══════════════════════════════════════════════════════════
async function runAgentJob(payload, ctx) {
  const { kind, id, context = {} } = payload || {};

  // إلغاء تعاوني: أُلغيت قبل أن نبدأ؟ عودة فورية، ويتكفّل الطابور بحسم الحالة
  // (لا نرمي — الرمي يبدو فشلًا في السجلّ بينما الإلغاء قرار المستخدم).
  if (ctx.signal.aborted) return { cancelled: true };

  ctx.progress('starting', 5);
  const startedAt = Date.now();

  let result;
  try {
    const orch = getOrchestrator();
    if (kind === 'agent') {
      result = await orch.runAgent(id, context);
    } else if (kind === 'squad') {
      result = await orch.runSquad(id, context);
    } else if (kind === 'workflow') {
      result = await orch.runWorkflow(id, context);
    } else {
      throw codeError('invalid-kind', `نوع تشغيل غير معروف: ${kind}`);
    }
  } catch (e) {
    // إعادة الرمي مع الحفاظ على .code: الطابور (queue.js) يقرأ e.code ليعيّن
    // حالة الوظيفة الفاشلة بالرمز الصحيح. الأخطاء العارية بلا كود تسقط 500.
    const err = e && e.code ? e : codeError('agent-run-failed', (e && e.message) || String(e));
    throw err;
  }

  ctx.progress('running ' + kind, 30);

  // تسجيل الملخص والأوقات في السجلّ — مصدر الحالة الفعلي هو أحداث الطابور
  // (onJobUpdate)، لكن المعالج يملؤهما هنا أيضًا حتى لا يبقى السجلّ ناقصًا
  // لو تأخّر أول تحديث أو سبق الحدثُ التسجيلَ بخطوة واحدة.
  const rec = runsMap.get(ctx.jobId);
  if (rec) {
    rec.startedAt = rec.startedAt || startedAt;
    rec.finishedAt = Date.now();
    rec.summary = buildSummary(kind, result, id);
  }
  return result;
}

// المنسّق يُبنى عند أول استخدام (Lazy): لا نُهيئ سجلًّا كاملًا من الوكلاء عند
// تحميل الخادم لمجرّد أن البوابة مثبّتة، والاختبارات تستبدله بمقلّد قبل أي تشغيل.
let orchestrator = null;
function getOrchestrator() {
  if (!orchestrator) orchestrator = new Orchestrator();
  return orchestrator;
}

// ═══════════════════════════════════════════════════════════
// مزامنة حالة السجلّ من أحداث الطابور — مصدر الحالة للموثوقية
// ═══════════════════════════════════════════════════════════
function onJobUpdate(update) {
  const rec = runsMap.get(update && update.id);
  if (!rec) return; // تحديث لوظيفة ليست تشغيل وكيل
  if (update.status) rec.status = update.status;
  if (update.startedAt) rec.startedAt = update.startedAt;
  if (update.finishedAt) rec.finishedAt = update.finishedAt;
}

// ═══════════════════════════════════════════════════════════
// التسجيل في طابور — idempotent لكل طابور (الاختبارات تمرّر طوابير وهمية)
// ═══════════════════════════════════════════════════════════
const registeredQueues = new Set();
const unsubscribers = new Map(); // طابور → دالة إلغاء الاشتراك بأحداثه

function register(jobsQueue = jobs) {
  if (registeredQueues.has(jobsQueue)) return; // حارس: مرة واحدة لكل طابور
  registeredQueues.add(jobsQueue);
  jobsQueue.registerHandler(JOB_TYPE, runAgentJob);
  if (jobsQueue.events && typeof jobsQueue.events.on === 'function') {
    jobsQueue.events.on('update', onJobUpdate);
    unsubscribers.set(jobsQueue, () => jobsQueue.events.off('update', onJobUpdate));
  }
}

// للاختبارات: فكّ الاشتراك من أحداث الطابور لمنع تسريب المراجع
function close() {
  for (const off of unsubscribers.values()) {
    try { off(); } catch { /* لا شيء */ }
  }
  unsubscribers.clear();
  registeredQueues.clear();
}

// ═══════════════════════════════════════════════════════════
// بوابة الدفع: تحقق من السياسة ← إنشاء وظيفة ← تسجيل في السجلّ
// ═══════════════════════════════════════════════════════════
function enqueueRun({ kind, id, context, projectId }) {
  // التحقق أولًا: تشغيل بلا تحقق = وكيل غير موجود يُدفع ثم يفشل في الطابور
  // فيستهلك مقعدًا بلا فائدة. السياسة تحلّ المعرّف القديم (A1.1 → S1:T3) أيضًا
  const v = policy.validateRun({ kind, id });
  if (!v || !v.ok) throw codeError(
    v && v.error ? v.error : 'invalid-kind',
    'تشغيل غير صالح: ' + kind + ' ' + id,
  );

  const job = jobs.enqueue(JOB_TYPE, {
    kind: v.kind,
    id: v.id,
    context: context && typeof context === 'object' ? context : {},
    projectId: typeof projectId === 'string' && projectId ? projectId : null,
  });

  runsMap.set(job.id, {
    jobId: job.id,
    kind: v.kind,
    id: v.id,
    label: v.label || v.id,
    weight: typeof v.weight === 'number' && Number.isFinite(v.weight) ? v.weight : 1,
    status: job.status,
    projectId: projectId || null,
    createdAt: job.createdAt,
    startedAt: null,
    finishedAt: null,
    summary: null,
  });
  evictOldest();
  return job;
}

// السجلّ كاملًا — الأحدث أولًا، بسقف MAX_RUNS
function runs() {
  return Array.from(runsMap.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_RUNS);
}

// التسجيل التلقائي عند التحميل: نفس عقد projectPipeline.js
// (jobs.registerHandler عند تحميل الوحدة) — بلا ذلك تكون أول enqueue
// 'نوع وظيفة مجهول' وتفشل البوابة كلها بمجرد تركيبها.
register();

module.exports = {
  JOB_TYPE,
  register,
  enqueueRun,
  runs,
  close,
  // مساعدات للاختبارات — لا تُستخدم في المسارات
  runAgentJob,
  buildSummary,
};
