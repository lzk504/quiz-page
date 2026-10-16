const fs = require('fs');
const { execSync } = require('child_process');

const original = execSync('git show HEAD:webapp/src/style.css', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const lines = original.split(/\r?\n/);

// 1. forms.css
const formsContent = `/* ==========================================================================
   通用表单输入组件
   ========================================================================== */

/* ---------- 表单字段 ---------- */
${lines.slice(839, 854).join('\n')}
`;
fs.writeFileSync('webapp/src/css/components/forms.css', formsContent, 'utf8');
console.log('Fixed forms.css');

// 2. login.css
const loginContent = `/* ==========================================================================
   登录 / 注册 / 邀请码
   ========================================================================== */

${lines.slice(815, 839).join('\n')}

${lines.slice(854, 885).join('\n')}
`;
fs.writeFileSync('webapp/src/views/login.css', loginContent, 'utf8');
console.log('Fixed login.css');

// 3. layout.css
const layoutContent = `/* ==========================================================================
   全局布局与骨架
   ========================================================================== */

${lines.slice(114, 125).join('\n')}

${lines.slice(125, 155).join('\n')}

${lines.slice(155, 163).join('\n')}

${lines.slice(163, 196).join('\n')}

${lines.slice(587, 620).join('\n')}

${lines.slice(669, 703).join('\n')}

${lines.slice(1180, 1221).join('\n')}

${lines.slice(1221, 1246).join('\n')}

${lines.slice(1739, 1750).join('\n')}
`;
fs.writeFileSync('webapp/src/css/base/layout.css', layoutContent, 'utf8');
console.log('Fixed layout.css');

// 4. practice.css
const practiceContent = `/* ==========================================================================
   通用题目容器与刷题交互
   ========================================================================== */

${lines.slice(369, 527).join('\n')}

${lines.slice(650, 669).join('\n')}

${lines.slice(926, 957).join('\n')}

${lines.slice(957, 978).join('\n')}
`;
fs.writeFileSync('webapp/src/views/practice-hub/practice.css', practiceContent, 'utf8');
console.log('Fixed practice.css');
