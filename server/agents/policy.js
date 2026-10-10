// server/agents/policy.js — حوكمة تشغيل الوكلاء والفرق وسير العمل
//
// لماذا وحدة مستقلة قبل بوابة API: كل مسار يبدأ بالتشغيل (وكيل، فرقة، سير عمل)
// يحتاج نقطة تحقق واحدة — معرّف صحيح؟ فئة معروفة؟ أداة مسموحة؟ ميزانية كاملة؟
// تتركز القواعد هنا مرة واحدة بدل أن تتشتت في routes-*.js، فتبقى سياسة واحدة
// قابلة للتدقيق والتعديل — وأي بوابة/واجهة تلتزم بها تقنيًا.
//
// قواعد الأمان:
//   • restricted أدوات تنفّذ أوامر/اختبارات على النظام (run_command…) ممنوعة
//     على الوكلاء — أداة مسموحة تعني «آمنة افتراضيًا» وليس «مطلوبة».
//   • الميزانيات (iterations/llmCalls/translateChars/toolCalls) تُقرأ من
//     بيئة التشغيل بكسل (عند إنشاء الميزانية لا عند تحميل الوحدة) حتى يظل
//     التعديل ممكنًا بلا إعادة إقلاع: AGENT_MAX_* إن وُجد يعلو على الافتراضي
//     في RULES.budget، والـ overrides الصريحة في makeBudget() هي الأعلى.
//
// ملاحظة المسارات النسبية: هذه الوحدة داخل server/agents/ لذا الانتقال إلى
// سجل الوكلاء والأدوات يبدأ بـ ../../agents/... (جذر المشروع ثم agents/).
// الـ "../agents/..." كانت ستشير لـ server/agents/core/ وفيها لا شيء — لا تغيّرها.

const { AGENTS, WORKFLOWS, resolveAgentId, getSquad } = require('../../agents/core/registry');
const { TOOLS } = require('../../agents/core/tools');

// ═══════════════════════════════════════════════════════════
// القواعد — تُقرأ في وقت التحميل (السماح بالأدوات ثابت أثناء عمر العملية)
// ═══════════════════════════════════════════════════════════
// أدوات تنفيذ الأوامر على الجهاز — أي وكيل يطلبها يُرفض تلقائيًا
const RESTRICTED_TOOLS = ['run_command', 'run_tests', 'run_lint', 'syntax_check'];

const RULES = {
  // فئات التشغيل المعترف بها — أي شيء خارجها «فئة غير صالحة»
  kinds: ['agent', 'squad', 'workflow'],

  // ميزانيات الأمان لكل تشغيل (قيم افتراضية؛ تُستبدل بكسل من AGENT_MAX_*
  // عند إنشاء الميزانية عبر makeBudget() — انظر أعلاه)
  budget: {
    maxIterations: 6,
    maxLlmCalls: 8,
    maxTranslateChars: 4500,
    maxToolCalls: 40,
  },

  // الأداة إما آمنة (خارج القائمة المحظورة) أو محظورة؛ «safe» تُشتق من
  // TOOLS الفعلية أيًا كانت — لا نسخة يدوية تتقادم عند إضافة أداة.
  allowlist: {
    restricted: RESTRICTED_TOOLS,
    safe: Object.keys(TOOLS).filter((t) => !RESTRICTED_TOOLS.includes(t)),
  },
};

// ═══════════════════════════════════════════════════════════
// التحقق من طلب تشغيل — { kind, id } → { ok, ... } بلا أي عمل جانبي
// ═══════════════════════════════════════════════════════════
// أوزان التشغيل تقديرية لأغراض التزامن/الأولوية في بوابة API:
//   • وكيل (القائد + فرعيه) = 3
//   • فرقة كاملة (5 قادة × 3) = 15
//   • سير عمل = مجموع أوزان كل الموجات (موجة فرق = 15 × عدد الفرق،
//     موجة وكلاء = 3 × عدد الوكلاء) — يقارب العدد الحقيقي للوكلاء.
function validateRun({ kind, id } = {}) {
  // 1) الفئة: يجب أن تكون سلسلة ضمن المعترف بها — وإلا رفض فوري
  if (typeof kind !== 'string' || !RULES.kinds.includes(kind)) {
    return { ok: false, error: 'invalid-kind' };
  }

  // 2) المعرّف: سلسلة غير فارغة؛ والمعرّف غير الصالح = غير موجود
  if (typeof id !== 'string' || !id.trim()) {
    const notFound = { agent: 'agent-not-found', squad: 'squad-not-found', workflow: 'workflow-not-found' };
    return { ok: false, error: notFound[kind] };
  }

  // 3) فئات محددة — كل فئة لها مصدر الحقيقة الخاص بها
  switch (kind) {
    case 'agent': {
      // المعرّف القديم (A1.1) يُحل تلقائيًا للمعرّف الجديد (S1:T3)
      const resolved = resolveAgentId(id);
      if (!resolved) return { ok: false, error: 'agent-not-found' };
      const agent = AGENTS[resolved];
      return {
        ok: true,
        kind,
        id: resolved,                       // الهوية الفعلية بعد الحل، لا ما أرسله المتصل
        label: agent.nameAr || agent.name || resolved,
        weight: 3,                          // قائد + فرعيان
      };
    }
    case 'squad': {
      const squad = getSquad(id);
      if (!squad) return { ok: false, error: 'squad-not-found' };
      return {
        ok: true,
        kind,
        id,
        label: squad.name || id,
        weight: 15,                         // 5 قادة × 3 وكلاء
      };
    }
    case 'workflow': {
      const workflow = WORKFLOWS[id];
      if (!workflow) return { ok: false, error: 'workflow-not-found' };
      let weight = 0;
      for (const wave of workflow.waves || []) {
        const count = Array.isArray(wave.agents) ? wave.agents.length : 0;
        weight += wave.squads ? count * 15 : count * 3;
      }
      return {
        ok: true,
        kind,
        id,
        label: workflow.name || id,
        weight,
      };
    }
    default:
      // لا يمكن الوصول هنا بعد فحص الفئة أعلاه — لكن يبقى لأمان المستقبل
      return { ok: false, error: 'invalid-kind' };
  }
}

// ═══════════════════════════════════════════════════════════
// ميزانية تشغيل — عدّادات تنازلية من الحد الأقصى إلى الصفر
// ═══════════════════════════════════════════════════════════
const BUDGET_KINDS = ['iterations', 'llmCalls', 'translateChars', 'toolCalls'];

// أسماء متغيرات البيئة ومفاتيح الافتراضيات لكل نوع صرف
const ENV_MAX = {
  iterations: 'AGENT_MAX_ITERATIONS',
  llmCalls: 'AGENT_MAX_LLM_CALLS',
  translateChars: 'AGENT_MAX_TRANSLATE_CHARS',
  toolCalls: 'AGENT_MAX_TOOL_CALLS',
};
const DEFAULT_MAX = {
  iterations: 'maxIterations',
  llmCalls: 'maxLlmCalls',
  translateChars: 'maxTranslateChars',
  toolCalls: 'maxToolCalls',
};

// أعلى سقف لنوع صرف: overrides صريحة ← AGENT_MAX_* (كسل) ← الافتراضي
function resolveMax(kind, overrides) {
  const direct = overrides[kind];
  if (typeof direct === 'number' && direct >= 0) return direct;
  const aliased = overrides[DEFAULT_MAX[kind]];
  if (typeof aliased === 'number' && aliased >= 0) return aliased;
  const envVal = Number(process.env[ENV_MAX[kind]]);
  if (Number.isFinite(envVal) && envVal >= 0) return envVal;
  return RULES.budget[DEFAULT_MAX[kind]];
}

/**
 * ميزانية قابلة للصرف — تبدأ من السقف وتنقص مع كل consume().
 *
 * makeBudget(overrides) — overrides: { iterations?, llmCalls?,
 * translateChars?, toolCalls? } (يقبل أيضًا maxIterations… المرادف).
 *
 * consume(kind, n=1) → false عند نفاد السقف (يترك الميزانية كما هي)،
 *                   وإلا ينقص n ويعيد true.
 * left(kind)       → المتبقي من نوع الصرف.
 * reset()          → إعادة السقف (يعيد قراءة AGENT_MAX_* من جديد).
 * snapshot()       → { iterations, llmCalls, translateChars, toolCalls }
 *                    بقيمها المتبقية الحالية.
 */
function makeBudget(overrides = {}) {
  let left = Object.fromEntries(BUDGET_KINDS.map((k) => [k, resolveMax(k, overrides)]));

  return {
    consume(kind, n = 1) {
      if (!BUDGET_KINDS.includes(kind) || !(kind in left)) return false;
      const need = Number(n) > 0 ? Math.floor(Number(n)) : 1;
      if (left[kind] < need) return false;   // نفاد: لا تغيير على الحالة
      left[kind] -= need;
      return true;
    },
    left(kind) {
      return BUDGET_KINDS.includes(kind) && kind in left ? left[kind] : 0;
    },
    reset() {
      left = Object.fromEntries(BUDGET_KINDS.map((k) => [k, resolveMax(k, overrides)]));
      return this;
    },
    snapshot() {
      return { ...left };
    },
  };
}

// ═══════════════════════════════════════════════════════════
// فحص الأدوات — بوابة تعرف قبل التنفيذ هل يستحق الوكيل محاولة أصلاً
// ═══════════════════════════════════════════════════════════
// قواعد صارمة: غير المعروفة مرفوضة (الأداة الجديدة غير المعلنة = مشبوهة)،
// والمحظورة مرفوضة دائمًا مهما كانت الحجة.
function allowTool(name) {
  return RULES.allowlist.safe.includes(name);
}

function toolRisks(name) {
  if (RULES.allowlist.restricted.includes(name)) return 'restricted';
  if (RULES.allowlist.safe.includes(name)) return 'safe';
  return 'unknown';
}

module.exports = { RULES, validateRun, makeBudget, allowTool, toolRisks };