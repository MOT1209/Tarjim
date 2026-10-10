// server/providers/translation/hymt2.js — Hy-MT2 (Tencent)
// نموذج ترجمة Multilingual "fast-thinking" من Tencent Hunyuan.
// يدعم 33 لغة包括 العربية، وأحجام: 1.8B (خفيف - 440MB مع quantization),
// 7B، و 30B-A3B (MoE).

// للاستخدام المحلي: نحمّل Hy-MT2-1.8B via @xenova/transformers.
// للنسخ الأكبر (7B، 30B) نوصي الخدمة الخارجية أو vLLM.

// Installed as optionalDependency: "@xenova/transformers" (already in package.json)
async function translateViaHyMT2(text, _targetLang, _sourceLang) {
  // التأكد من توفر @xenova/transformers
  const { default: { pipeline } } = await import('@xenova/transformers');
  // استيراد lazy لتجنب البطء عند البداية
  const classifier = await pipeline('translation', 'tencent/Hy-MT2-1.8B', {
    quantized: true, // استخدام AngelSlim quantization (1.25-bit) لتقليل الاستخدام
    device: 'cpu', // 'cuda' إن توفرت
    torch_dtype: 'bfloat16',
  });

  // بناءprompt בהתאם لنمط Hy-MT2
  const prompt = `Translate the following text to ${_targetLang}. 
Note: only output the translated result, no additional explanation:
${text}`;

  const result = await classifier(prompt);
  // النتيجة من pipeline قد تكون object أو string اعتمادًا على الإصدار
  let translated = '';
  if (typeof result === 'object' && result[0] && result[0].text) {
    translated = result[0].text;
  } else if (typeof result === 'string') {
    translated = result;
  } else if (Array.isArray(result)) {
    translated = result.join('\n');
  }
  return translated.trim();
}

// Fallback: إذا فشل النموذج،ارجع النص الأصلي مع علامة (لا يُخزَّن في الكاش)
function _fallback(text) {
  return `[Hy-MT2 fallback] ${text}`;
}

module.exports = {
  id: 'hymt2',
  label: 'Hy-MT2 (Tencent، 1.8B)',
  requiresKey: false,
  // النموذج يُحمَّل عند الاستدعاء الأول; قد يستغرق وقتًا (5-15 ثانية)
  isAvailable: () => true,
  translate: translateViaHyMT2,
};