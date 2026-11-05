/**
 * Script guards for replies. The models occasionally leak CJK tokens into Vietnamese
 * answers; the prompt asks them not to, and this is the deterministic backstop.
 */
const FOREIGN_SCRIPT = /[\u1100-\u11ff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const FOREIGN_SCRIPT_GLOBAL = new RegExp(FOREIGN_SCRIPT.source, 'g');
const VI_DIACRITICS = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/;

/** @param {string} text */
export function hasForeignScript(text) {
  return FOREIGN_SCRIPT.test(String(text ?? ''));
}

/** @param {string} text */
export function stripForeignScript(text) {
  return String(text ?? '').replace(FOREIGN_SCRIPT_GLOBAL, '');
}

/** @param {string} text */
export function isVietnameseText(text) {
  return VI_DIACRITICS.test(String(text ?? ''));
}

/**
 * Keep the original script when the user wrote in it or explicitly asked for that language;
 * only plain Vietnamese/English turns get the leak filter.
 * @param {string} userText
 */
export function languageAllowsForeign(userText) {
  const source = String(userText ?? '');
  if (hasForeignScript(source)) return true;
  return /\b(tiếng trung|tiếng nhật|tiếng hàn|trung quốc|nhật bản|hàn quốc|chinese|japanese|korean|hán tự|kanji|kana|dịch\s+(sang\s+)?(tiếng\s+)?(trung|nhật|hàn))\b/i.test(
    source,
  );
}
