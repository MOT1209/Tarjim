// server/errorHelpers.js — معالجة أخطاء موحدة لمسارات API
//
// لماذا: كل routes-*.js كان يُعرّف ERROR_STATUS + sendError + scrubSecrets بنفس الطريقة
// تقريبًا. الآن تتولّاها وحدة مشتركة — يُضاف أي كود خطأ جديد مرة واحدة.

// ===== خريطة رمز الخطأ → حالة HTTP (مُجمّعة من كل المسارات) =====
const ERROR_STATUS = {
  // ── ترجمة (routes-translate) ──
  'invalid-url': 400,
  'fetch-failed': 422,
  'no-transcript': 422,
  'audio-empty': 422,
  'content-empty': 422,
  'pdf-unsupported': 422,
  'invalid-settings': 400,
  'blocked-url': 400,
  'rate-limited': 429,
  'translate-failed': 502,
  'server-error': 500,
  'invalid-text': 400,
  'smart-unavailable': 503,
  'input-too-large': 413,
  'alignment-failed': 502,
  'gemini-video-failed': 502,
  'gemini-model-unavailable': 502,
  'gemini-rate-limited': 429,
  'gemini-video-disabled': 503,
  'video-too-long': 422,
  'download-failed': 502,
  'youtube-blocked': 422,
  'ytdlp-missing': 500,

  // ── ملفات (routes-file) ──
  'invalid-format': 400,
  'invalid-file': 400,
  'invalid-export': 400,

  // ── OCR (routes-ocr) ──
  'ocr-not-ready': 503,
  'ocr-empty': 422,

  // ── يوتيوب (routes-youtube) ──
  'video-not-found': 404,
  'youtube-quota': 429,
  'youtube-api-disabled': 503,
  'youtube-api-failed': 502,

  // ── فيديو محلي (routes-local-video) ──
  'queue-full': 503,
  'job-cancelled': 499,

  // ── مشاريع (routes-projects) ──
  'invalid-project': 400,
  'invalid-asset': 400,
  'invalid-storage-key': 400,
  'project-not-found': 404,
  'asset-not-found': 404,

  // ── TTS ──
  'tts-failed': 502,
  'text-too-long': 413,

  // ── وكلاء (routes-agents) ──
  'invalid-kind': 400,
  'agent-not-found': 404,
  'squad-not-found': 404,
  'workflow-not-found': 404,
  'invalid-request': 400,
};

// ===== إزالة مفاتيح API من النصوص قبل إرسالها للعميل =====
function scrubSecrets(t) {
  return String(t || '')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[مفتاح محجوب]')
    .replace(/key=[^&\s"]+/gi, 'key=[محجوب]')
    // DeepL keys: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx(:fx)?
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(:fx)?/gi, '[مفتاح محجوب]')
    // OpenAI / Zen style keys: sk-xxxxxxxxxxxxxxxxxxxxxxxx
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[مفتاح محجوب]');
}

/**
 * استجابة خطأ موحدة — ترسل JSON { error: code } مع كود HTTP صحيح.
 *
 * opts:
 *   - label?: string  — بادئة سجل الخادم (الافتراضي 'app')
 *   - detail?: boolean — إرسال جزء من e.message مع تفاصيل Gemini (الافتراضي true)
 */
function sendError(res, e, opts = {}) {
  const { label = 'app', detail = true } = opts;

  // رمز الخطأ يجب أن يكون سلسلة معروفة. عمليات execFile الفاشلة تحمل code
  // رقميًا (رمز الخروج)، فكان يتسرّب للواجهة كـ {"error":1} — بلا معنى.
  const raw = e && e.code;
  const code = typeof raw === 'string' && ERROR_STATUS[raw] ? raw : 'server-error';
  const status = ERROR_STATUS[code] || 500;
  console.error(`[${label}] error:`, code, '→', e && e.message);

  const payload = { error: code };
  // أخطاء Gemini وحدها تحمل تفصيلًا: سجلّ الخادم غير متاح على الاستضافة
  // المدارة، وبلا هذا التفصيل يستحيل تشخيص سبب الفشل من الخارج.
  if (detail && code.startsWith('gemini-') && e && e.message) {
    payload.detail = scrubSecrets(e.message).slice(0, 300);
  }
  return res.status(status).json(payload);
}

module.exports = { sendError, ERROR_STATUS, scrubSecrets };
