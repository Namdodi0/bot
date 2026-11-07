/**
 * Language-drift detection used for a single regeneration pass. This deliberately does not
 * rewrite text: it only answers "did the model leave the requested script?".
 */
const FOREIGN_SCRIPT =
  /[\u1100-\u11ff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** @param {string} text */
export function containsForeignScript(text) {
  return FOREIGN_SCRIPT.test(String(text ?? ''));
}

/**
 * True when the user wrote in a foreign script or explicitly asked for one of those
 * languages, so a retry would be wrong.
 * @param {string} userText
 */
export function allowsForeignScript(userText) {
  const source = String(userText ?? '');
  if (containsForeignScript(source)) return true;
  return /\b(tiếng trung|tiếng nhật|tiếng hàn|trung quốc|nhật bản|hàn quốc|chinese|japanese|korean|hán tự|kanji|kana)\b/i.test(
    source,
  );
}