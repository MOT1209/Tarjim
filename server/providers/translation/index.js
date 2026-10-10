// server/providers/translation/index.js — المزوّدون المدمجين بترتيب الأولوية
//
// الترتيب هنا **هو** السلسلة الافتراضية حين لا يفرض الطلب ولا PROVIDER_ORDER
// ترتيبًا آخر: الأسرع والمجاني بلا مفتاح أولاً، ثم ما يحتاج مفتاحًا.
// إضافة مزوّد = ملف جديد + سطر هنا. لا تُعدَّل نواة translate.js.
module.exports = [
  require('./google'),
  require('./mymemory'),
  require('./libre'),
  require('./gemini'),
  require('./deepl'),
  require('./zen'),
  require('./hymt2'),
];