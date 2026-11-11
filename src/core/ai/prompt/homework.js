const TASK =
  /\b(?:giải\s+(?:bài|đề|toán|lý|hóa|sinh|phương\s+trình|hệ|giúp|hộ|dùm|dum)|bài\s+tập|đề\s+bài|đề\s+thi|chứng\s+minh|tính\s+(?:toán|giá\s+trị|đạo\s+hàm|tích\s+phân|diện\s+tích|thể\s+tích)|tìm\s+x|phương\s+trình|hệ\s+phương\s+trình|đạo\s+hàm|tích\s+phân|trắc\s+nghiệm|soạn\s+bài|viết\s+(?:bài|đoạn)|nghị\s+luận|lập\s+trình|thuật\s+toán|viết\s+code|solve|homework|assignment|prove|calculate|find\s+x|derivative|integral|equation|multiple\s+choice|programming|algorithm)\b/;

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
  if ((source.match(CHOICE) ?? []).length >= 2) return true;
  return (
    SUBJECT.test(source) &&
    /\?/.test(source) &&
    /\b(?:tại\s+sao|vì\s+sao|như\s+thế\s+nào|what|why|how|explain|trình\s+bày|nêu|phân\s+tích)\b/.test(
      source,
    )
  );
}
