/**
 * 判分核心。
 *
 * 规则：
 *  - 单选：字母全等
 *  - 多选：集合相等（全对才算对，错选/漏选均判错）
 *  - 判断：布尔值全等
 *  - 填空：逐空宽松匹配（NFKC 归一 + 去空白 + 忽略大小写 + 去句读标点），
 *          每空命中其 accept 别名数组中的任意一项即算对该空；整题全对才算对
 */

/** 标点归一：句读类标点直接剔除，保留有语义的符号 */
const PUNCT_RE = /[。．.，,、；;：:！!？?（）()【】\[\]{}「」『』“”‘’"'·~～\-—_/／\\|]/g;

/** 文本归一化：用于填空题比对（用户输入与标准答案走同一函数） */
export function normalizeText(input) {
  let s = String(input ?? "");
  try {
    s = s.normalize("NFKC");
  } catch { /* 老浏览器忽略 */ }
  s = s
    .replace(/\s+/g, "")      // 去掉全部空白（含 NFKC 后的普通空格）
    .toLowerCase();
  s = s.replace(PUNCT_RE, "");
  return s;
}

/** 填空单空判定 */
export function checkBlank(blank, userInput) {
  const got = normalizeText(userInput);
  if (!got) return false;
  return (blank?.accept ?? []).some((a) => normalizeText(a) === got);
}

/** 单选 */
export function gradeSingle(question, letter) {
  const correct = String(letter ?? "").toUpperCase() === String(question.answer).toUpperCase();
  return { correct };
}

/** 多选 */
export function gradeMultiple(question, letters) {
  const got = new Set((letters ?? []).map((l) => String(l).toUpperCase()));
  const want = new Set((question.answer ?? []).map((l) => String(l).toUpperCase()));
  const correct = got.size === want.size && [...want].every((l) => got.has(l));
  return { correct };
}

/** 判断 */
export function gradeJudge(question, value) {
  return { correct: Boolean(value) === Boolean(question.answer) };
}

/** 填空：返回 perBlank 便于逐空染色 */
export function gradeFill(question, inputs) {
  const perBlank = (question.answer ?? []).map((blank, i) => checkBlank(blank, inputs?.[i]));
  return { correct: perBlank.every(Boolean), perBlank };
}

/** 统一入口：判断题型的判分函数；简答题返回 null（不判分） */
export function grade(question, userAnswer) {
  switch (question.type) {
    case "single":   return gradeSingle(question, userAnswer);
    case "multiple": return gradeMultiple(question, userAnswer);
    case "judge":    return gradeJudge(question, userAnswer);
    case "fill":     return gradeFill(question, userAnswer);
    default:         return null;
  }
}

/** 选择题答案的展示形式：['A','B'] → "AB" */
export function displayAnswer(question) {
  switch (question.type) {
    case "single":
      return String(question.answer);
    case "multiple":
      return (question.answer ?? []).join("");
    case "judge":
      return question.answer ? "√ 正确" : "× 错误";
    case "fill":
      return (question.answer ?? []).map((b) => b.display).join(" ／ ");
    case "short":
      return question.answer;
    default:
      return "";
  }
}

/** 用户答案的展示形式（用于错题本回显） */
export function displayUserAnswer(question, userAnswer) {
  if (userAnswer === undefined || userAnswer === null || userAnswer === "") return "未作答";
  switch (question.type) {
    case "single":
      return String(userAnswer);
    case "multiple":
      return Array.isArray(userAnswer) ? userAnswer.join("") || "未选择" : String(userAnswer);
    case "judge":
      return userAnswer ? "√ 正确" : "× 错误";
    case "fill":
      return Array.isArray(userAnswer)
        ? userAnswer.map((v, i) => `第${i + 1}空「${v || "空"}」`).join(" ")
        : String(userAnswer);
    default:
      return String(userAnswer);
  }
}
