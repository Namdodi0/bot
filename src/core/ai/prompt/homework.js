const TASK =
  /\b(?:giải\s+(?:bài|đề|toán|lý|hóa|sinh|phương\s+trình|hệ|giúp|hộ|dùm|dum)|bài\s+tập|đề\s+bài|đề\s+thi|tính\s+(?:toán|giá\s+trị|đạo\s+hàm|tích\s+phân|diện\s+tích|thể\s+tích)|tìm\s+x|phương\s+trình|hệ\s+phương\s+trình|đạo\s+hàm|tích\s+phân|trắc\s+nghiệm|soạn\s+bài|viết\s+(?:bài|đoạn)|nghị\s+luận|lập\s+trình|thuật\s+toán|viết\s+code|solve\s+for\s+[a-z]|homework|find\s+x|derivative|integral|equation|multiple\s+choice|programming|algorithm)\b/;

const AMBIGUOUS_TASK = /\b(?:solve|prove|calculate|assignment|chứng\s+minh)\b/;

const MATH_TOPIC =
  /(?<![\p{L}\p{N}_])(?:theorem|lemma|formula|(?:algebraic|trigonometric)\s+identity|inequality|polynomial|fraction|triangle|circle|area|volume|perimeter|probability|(?:sum|product)\s+of|(?:even|odd|prime|real|natural|rational|irrational)\s+(?:numbers?|integers?)|primes|định\s+lý|bổ\s+đề|công\s+thức|đẳng\s+thức|bất\s+đẳng\s+thức|tam\s+giác|đường\s+thẳng|hình\s+tròn|diện\s+tích|thể\s+tích|chu\s+vi|xác\s+suất|số\s+(?:chẵn|lẻ|nguyên|thực|tự\s+nhiên|hữu\s+tỉ|vô\s+tỉ)|chia\s+hết)(?![\p{L}\p{N}_])/u;

const SYMBOLIC_RELATION = /\b[a-z]\s*(?:[<>]=|[=<>≤≥≠])\s*[a-z]\b/;

const ASSIGNMENT_REQUEST =
  /(?:\bhelp(?:\s+me)?\s+(?:with|on|do|complete|finish)|(?:^|\bplease\s+|\b(?:can|could|would)\s+you\s+)(?:do|complete|finish|explain|check|review|write))\s+(?:(?:my|this|the|an?)\s+)?assignment\b/;

const SUBJECT =
  /\b(?:toán|vật\s+lý|lý|hóa\s+học|hóa|sinh\s+học|sinh|ngữ\s+văn|văn|sử|lịch\s+sử|địa|lịa\s+lý|tiếng\s+anh|tin\s+học|math|physics|chemistry|biology|literature|history|geography|english|computer\s+science)\b/;

const MATH_EXPRESSION =
  /(?:\d\s*[+\-*/=<>]\s*\d|[a-z]\s*\^\s*\d|\b(?:sin|cos|tan|log|ln|sqrt)\s*\(|\b[a-z]\s*=\s*[-+]?\d)/;

// Two-digit day/month shapes (05/11, 25-12, 05/11/2026) are dates, not division;
// single-digit shapes like 1/2 stay math.
const DATE_SHAPE = /\b\d{2}[/-](?:0?[1-9]|1[0-2])(?:[/-]\d{2,4})?\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g;

const CHOICE = /(?:^|\n)\s*[a-d][.)]\s+\S/gi;

/**
 * Whether a message is asking for homework/problem-solving help. This only selects the
 * tutor overlay; the chat's own tone stays active.
 * @param {string} text
 */
export function isHomeworkRequest(text) {
  const source = String(text ?? '').toLowerCase();
  if (!source.trim()) return false;
  if (MATH_EXPRESSION.test(source.replace(DATE_SHAPE, ' '))) return true;
  if (TASK.test(source)) return true;
  // Ambiguous words need academic evidence in the same sentence, not elsewhere in a story.
  if (
    source.split(/[.!?;\n]+/).some(
      (sentence) =>
        AMBIGUOUS_TASK.test(sentence) &&
        (SUBJECT.test(sentence) ||
          MATH_TOPIC.test(sentence) ||
          SYMBOLIC_RELATION.test(sentence) ||
          ASSIGNMENT_REQUEST.test(sentence.trim())),
    )
  ) return true;
  if ((source.match(CHOICE) ?? []).length >= 2) return true;
  return (
    SUBJECT.test(source) &&
    /\?/.test(source) &&
    /\b(?:tại\s+sao|vì\s+sao|như\s+thế\s+nào|what|why|how|explain|trình\s+bày|nêu|phân\s+tích)\b/.test(
      source,
    )
  );
}
