const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const original = execSync('git show HEAD:webapp/src/style.css', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const lines = original.split(/\r?\n/);
console.log('Original total lines in style.css:', lines.length);

function checkBalance(ranges, name) {
  let depth = 0;
  for (const [s, e] of ranges) {
    for (let i = s - 1; i < e; i++) {
      const l = lines[i];
      for (const char of l) {
        if (char === '{') depth++;
        if (char === '}') depth--;
      }
    }
  }
  if (depth !== 0) {
    console.error('Unbalanced braces in ' + name + ': depth is ' + depth);
    return false;
  } else {
    console.log('Balanced: ' + name);
    return true;
  }
}

const slices = {
  // 1. Base
  'webapp/src/css/base/variables.css': [
    [1, 90]
  ],
  'webapp/src/css/base/reset.css': [
    [91, 114],
    [805, 815]
  ],
  'webapp/src/css/base/layout.css': [
    [115, 125],
    [126, 155],
    [156, 163],
    [164, 196],
    [588, 620],
    [670, 703],
    [1181, 1221], // 完整的 @media (max-width: 480px) 移动端专项增强
    [1222, 1246],
    [1740, 1750]
  ],

  // 2. Components
  'webapp/src/css/components/buttons.css': [
    [286, 338],
    [979, 985]
  ],
  'webapp/src/css/components/cards.css': [
    [197, 213]
  ],
  'webapp/src/css/components/forms.css': [
    [840, 854] // 通用表单 .field, .field__label, .field__input, .field__hint
  ],
  'webapp/src/css/components/chips.css': [
    [339, 369],
    [886, 894]
  ],
  'webapp/src/css/components/modal.css': [
    [704, 726],
    [727, 779],
    [780, 804]
  ],

  // 3. Views
  'webapp/src/views/home.css': [
    [214, 285],
    [1247, 1411],
    [1727, 1739]
  ],
  'webapp/src/views/banks.css': [
    [895, 926],
    [986, 1072],
    [1412, 1519]
  ],
  'webapp/src/views/wrongbook.css': [
    [1073, 1180],
    [1520, 1582]
  ],
  'webapp/src/views/me.css': [
    [557, 587],
    [621, 636],
    [637, 650],
    [1583, 1653]
  ],
  'webapp/src/views/favorites.css': [
    [528, 556],
    [1654, 1680]
  ],
  'webapp/src/views/login.css': [
    [816, 839],
    [855, 885]
  ],

  // 4. Practice-hub
  'webapp/src/views/practice-hub/practice.css': [
    [370, 527],
    [651, 669],
    [927, 957],
    [958, 978]
  ],
  'webapp/src/views/practice-hub/exam-card.css': [
    [1755, 1906]
  ],
  'webapp/src/views/practice-hub/exam.css': [
    [1681, 1726],
    [1751, 1754],
    [1907, 2365]
  ]
};

// 检查每个文件的括号平衡
let allBalanced = true;
for (const [relPath, ranges] of Object.entries(slices)) {
  const balanced = checkBalance(ranges, relPath);
  if (!balanced) allBalanced = false;
}

// 检查行覆盖
const assigned = new Array(lines.length + 1).fill(0);
for (const [file, ranges] of Object.entries(slices)) {
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) {
      if (assigned[i] > 0) {
        console.error('Line conflict at ' + i + ' for ' + file);
      }
      assigned[i]++;
    }
  }
}

let unassigned = [];
for (let i = 1; i <= lines.length; i++) {
  if (assigned[i] === 0) {
    unassigned.push(i);
  }
}
console.log('Unassigned lines:', unassigned.length);

if (!allBalanced || unassigned.length > 0) {
  console.error('Validation failed, aborting write.');
  process.exit(1);
}

// 写入各切片文件
for (const [relPath, ranges] of Object.entries(slices)) {
  const fullPath = path.resolve(relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const chunk = ranges.map(([s, e]) => lines.slice(s - 1, e).join('\n')).join('\n\n') + '\n';
  fs.writeFileSync(fullPath, chunk, 'utf8');
  console.log('Written: ' + relPath + ' (' + chunk.split('\n').length + ' lines)');
}

// 写入 webapp/src/css/index.css
const indexCssContent = `/* ==========================================================================
   全局基础样式与通用组件聚合入口
   ========================================================================== */

/* 1. Base 基础层 */
@import "./base/variables.css";
@import "./base/reset.css";
@import "./base/layout.css";

/* 2. Components 通用组件层 */
@import "./components/buttons.css";
@import "./components/cards.css";
@import "./components/forms.css";
@import "./components/chips.css";
@import "./components/modal.css";
`;

fs.writeFileSync(path.resolve('webapp/src/css/index.css'), indexCssContent, 'utf8');
console.log('Written: webapp/src/css/index.css');

// 写入转发式 webapp/src/style.css
const forwardStyleCss = `/* ==========================================================================
   向后兼容入口：转发至模块化 CSS 目录
   ========================================================================== */
@import "./css/index.css";
`;
fs.writeFileSync(path.resolve('webapp/src/style.css'), forwardStyleCss, 'utf8');
console.log('Updated: webapp/src/style.css as forwarder');
