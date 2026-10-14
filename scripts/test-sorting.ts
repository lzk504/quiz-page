import { chapterOrderSort, smartPracticeSort } from "../webapp/src/goal";
import type { Question, QuizStore } from "../webapp/src/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const mockQuestions: Question[] = [
  { id: "G-F001", type: "fill", stem: "填空1", domain: "health", answer: "a" },
  { id: "G-J001", type: "judge", stem: "判断1", domain: "health", answer: true },
  { id: "G-S002", type: "single", stem: "单选2", domain: "health", options: ["A","B"], answer: "A" },
  { id: "G-H001", type: "short", stem: "简答1", domain: "health", answer: "c" },
  { id: "G-M001", type: "multiple", stem: "多选1", domain: "health", options: ["A","B"], answer: ["A"] },
  { id: "G-S001", type: "single", stem: "单选1", domain: "health", options: ["A","B"], answer: "A" },
];

// Test 1: chapterOrderSort
const sortedChapter = chapterOrderSort(mockQuestions);
const types = sortedChapter.map((q) => q.type);
console.log("chapterOrderSort types:", types);
assert(types[0] === "single" && types[1] === "single", "First two are single choice");
assert(sortedChapter[0].id === "G-S002" && sortedChapter[1].id === "G-S001", "Preserves relative order within same type");
assert(types[2] === "multiple", "Third is multiple");
assert(types[3] === "judge", "Fourth is judge");
assert(types[4] === "fill", "Fifth is fill");
assert(types[5] === "short", "Sixth is short");

// Test 2: smartPracticeSort
const mockStore: QuizStore = {
  version: 6,
  records: {
    "G-S001": { attempts: 1, wrongAttempts: 0, lastCorrect: true, firstAt: 1000, lastAt: 1000 },
    "G-S002": { attempts: 3, wrongAttempts: 2, lastCorrect: false, firstAt: 500, lastAt: 2000 },
    "G-M001": { attempts: 1, wrongAttempts: 0, lastCorrect: true, firstAt: 500, lastAt: 500 },
  },
  wrongbook: {
    "G-S002": { wrongCount: 2, addedAt: 1000, lastWrongAt: 2000 },
  },
  favorites: {},
  profile: {},
  updatedAt: Date.now(),
};

// G-F001, G-J001, G-H001 are fresh (not in records)
// G-S002 is wrong
// G-S001 and G-M001 are mastered (G-M001 lastAt=500, G-S001 lastAt=1000)
const smartSorted = smartPracticeSort(mockQuestions, mockStore);
const smartIds = smartSorted.map((q) => q.id);
console.log("smartPracticeSort ids:", smartIds);

const freshIds = new Set(["G-F001", "G-J001", "G-H001"]);
assert(freshIds.has(smartIds[0]) && freshIds.has(smartIds[1]) && freshIds.has(smartIds[2]), "First 3 are fresh questions");
assert(smartIds[3] === "G-S002", "Fourth is wrong question (G-S002)");
assert(smartIds[4] === "G-M001", "Fifth is oldest mastered question (lastAt 500)");
assert(smartIds[5] === "G-S001", "Sixth is newer mastered question (lastAt 1000)");

console.log("\nALL UNIT TESTS PASSED!");
