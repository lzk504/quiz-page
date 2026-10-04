/**
 * 判分核心。
 *
 * 规则：
 *  - 单选：字母全等
 *  - 多选：集合相等（全对才算对，错选/漏选均判错）
 *  - 判断：布尔值全等
 */

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

/** 统一入口 */
export function grade(question, userAnswer) {
  switch (question.type) {
    case "single":   return gradeSingle(question, userAnswer);
    case "multiple": return gradeMultiple(question, userAnswer);
    case "judge":    return gradeJudge(question, userAnswer);
    default:         return null;
  }
}

/** 标准答案的展示形式：['A','B'] → "AB" */
export function displayAnswer(question) {
  switch (question.type) {
    case "single":
      return String(question.answer);
    case "multiple":
      return (question.answer ?? []).join("");
    case "judge":
      return question.answer ? "√ 正确" : "× 错误";
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
    default:
      return String(userAnswer);
  }
}
