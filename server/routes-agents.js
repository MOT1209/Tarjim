// server/routes-agents.js — بوابة نظام الوكلاء (agents/) إلى HTTP
//   POST   /api/agents/run         تشغيل وكيل/فرقة/سير عمل (202 + وظيفة)
//   GET    /api/agents/runs        سجلّ التشغيلات (للأدمن وحده)
//   DELETE /api/agents/runs/:jobId إلغاء تشغيل قيد التنفيذ
//
// لماذا وحدة مستقلة؟ كل بوابة نظام الوكلاء تحتاج تحققًا ودفعًا وإلغاءً.
// دمجها في routes-jobs يُعقّد ملفًا كبيرًا؛ وبوابة مخصّصة هنا تحافظ على
// تفصيل مسؤولية واحدة: بوابة الوكيل هنا، متابعة الوظائف في routes-jobs.
//
// التنفيذ يمرّ بـ server/agentRunner.js: العمل الفعلي (وكيل أو فرقة كاملة)
// أثقل من عمر طلب HTTP، فيُتابَع عبر GET /api/jobs/:id أو بثّ /api/jobs/:id/stream
// — نفس عقد async ميزة فيديو المشاريع والفيديو المحلي.
const express = require('express');
const jobs = require('./jobs');
const agentRunner = require('./agentRunner'); // يسجّل معالج الوظيفة عند تحميله
const { requireAdmin, isAdmin } = require('./adminAuth');
const repo = require('./db/projects');
const { sendError: _sendError } = require('./errorHelpers');

const router = express.Router();
const PROJECT_TOKEN_HEADER = 'x-project-token';

// رموز فشل التحقق من السياسة — تُردّ 422 صراحةً قبل sendError لأن
// sendError mappings تُعيد 400/404، لكن هذه رفض منطقية (نوع أو وكيل غير موجود)
// وليست خطأ في الطلب نفسه.
const POLICY_ERROR_CODES = ['invalid-kind', 'agent-not-found', 'squad-not-found', 'workflow-not-found'];

function sendError(res, e) {
  return _sendError(res, e, { label: 'agents', detail: false });
}

// ===== تشغيل =====
// body: { kind, id, context?, projectId? }
// يتحقق من الشكل أولًا (400)، ثم السياسة (422)، ثم يدفع إلى الطابور (202).
router.post('/agents/run', (req, res) => {
  const body = req.body || {};
  const { kind, id, context, projectId } = body;

  // التحقق من الشكل: النوع والمعرّف مطلوبان كنصوص. السياق ومعرّف المشروع اختياريان.
  if (typeof kind !== 'string' || !kind || typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'invalid-request' });
  }
  if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
    return res.status(400).json({ error: 'invalid-request' });
  }
  if (projectId !== undefined && typeof projectId !== 'string') {
    return res.status(400).json({ error: 'invalid-request' });
  }

  try {
    const job = agentRunner.enqueueRun({
      kind,
      id,
      context: context || undefined,
      projectId: projectId || undefined,
    });
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      statusUrl: '/api/jobs/' + job.id,
      streamUrl: '/api/jobs/' + job.id + '/stream',
    });
  } catch (e) {
    // أخطاء السياسة (وكيل/فرقة/سير عمل غير موجود، أو نوع غير معروف) → 422
    if (e && e.code && POLICY_ERROR_CODES.includes(e.code)) {
      return res.status(422).json({ error: e.code });
    }
    // الأخطاء الأخرى (unknown-job-type من الطابور، أو أي خطأ غير متوقع) → 500
    return sendError(res, e);
  }
});

// ===== سجلّ التشغيلات — للأدمن وحده =====
// limit: افتراضي 20، سقف 100 (مطابق لمتطلبات OPENAPI)
router.get('/agents/runs', requireAdmin, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    res.json({ runs: agentRunner.runs().slice(0, limit) });
  } catch (e) {
    return sendError(res, e);
  }
});

// ===== إلغاء =====
// نفس نموذج ملكية routes-jobs.js: وظيفة مرتبطة بمشروع تتطلّب توكن المالك أو الأدمن.
// بدون projectId مخزّن → رابط قدرة للعامة (منشئه العام لا يملك توكنًا).
router.delete('/agents/runs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job-not-found' });
  const projectId = jobs.ownerProject(req.params.jobId);
  if (projectId) {
    const project = repo.getProject(projectId);
    if (!project || (!isAdmin(req) && !repo.verifyProjectOwner(project.id, req.get(PROJECT_TOKEN_HEADER)))) {
      return res.status(404).json({ error: 'job-not-found' });
    }
  }
  const cancelled = jobs.cancel(req.params.jobId);
  if (!cancelled) return res.status(404).json({ error: 'job-not-found' });
  res.json({ jobId: cancelled.id, status: cancelled.status });
});

module.exports = router;
