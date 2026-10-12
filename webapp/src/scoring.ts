/**
 * 判分核心。
 *
 * 规则：
 *  - 单选：字母全等
 *  - 多选：集合相等（全对才算对，错选/漏选均判错）
 *  - 判断：布尔值全等
 *  - 填空 / 简答：**用户自判**（先对照参考答案，再由用户点「我答对了 / 我答错了」），
 *    因此 grade() 对其返回 null，判定结果由 practice 直接交给 recordAnswer。
 */

import type { Question } from "./types";

export interface GradeResult {
  correct: boolean;
}

/** 是否为用户自判题型（填空 / 简答） */
export const isSelfJudged = (q: Question): boolean => q.type === "fill" || q.type === "short";

/** 单选 */
export function gradeSingle(question: Question, letter: unknown): GradeResult {
  const correct = String(letter ?? "").toUpperCase() === String(question.answer).toUpperCase();
  return { correct };
}

/** 多选 */
export function gradeMultiple(question: Question, letters: unknown): GradeResult {
  const got = new Set((Array.isArray(letters) ? letters : []).map((l) => String(l).toUpperCase()));
  const want = new Set((Array.isArray(question.answer) ? question.answer : []).map((l) => String(l).toUpperCase()));
  const correct = got.size === want.size && [...want].every((l) => got.has(l));
  return { correct };
}

/** 判断 */
export function gradeJudge(question: Question, value: unknown): GradeResult {
  return { correct: Boolean(value) === Boolean(question.answer) };
}

/** 统一入口（fill / short 为自判题型，返回 null） */
export function grade(question: Question, userAnswer: unknown): GradeResult | null {
  switch (question.type) {
    case "single":   return gradeSingle(question, userAnswer);
    case "multiple": return gradeMultiple(question, userAnswer);
    case "judge":    return gradeJudge(question, userAnswer);
    case "fill":
    case "short":    return null;   // 自判：由用户对照参考答案后自行判定
    default:         return null;
  }
}

/** 标准答案的展示形式：['A','B'] → "AB"；填空逐空列出 */
export function displayAnswer(question: Question): string {
  switch (question.type) {
    case "single":
      return String(question.answer);
    case "multiple":
      return (Array.isArray(question.answer) ? question.answer : []).join("");
    case "judge":
      return question.answer ? "√ 正确" : "× 错误";
    case "fill":
      return (Array.isArray(question.answer) ? question.answer : [])
        .map((a, i) => `${i + 1}．${String(a)}`).join("　");
    case "short":
      return String(question.answer ?? "");
    default:
      return "";
  }
}

/** 用户答案的展示形式（用于错题本回显 / 结算） */
export function displayUserAnswer(question: Question, userAnswer: unknown): string {
  const empty = userAnswer === undefined || userAnswer === null || userAnswer === "";
  switch (question.type) {
    case "fill": {
      if (!Array.isArray(userAnswer)) return empty ? "未作答" : String(userAnswer);
      const any = userAnswer.some((v) => String(v ?? "").trim());
      if (!any) return "未作答";
      return userAnswer.map((v, i) => `${i + 1}．${String(v ?? "").trim() || "（未填）"}`).join("　");
    }
    case "short": {
      const text = String(userAnswer ?? "").trim();
      return text || "未作答";
    }
    default:
      break;
  }
  if (empty) return "未作答";
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
