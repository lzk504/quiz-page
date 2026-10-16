const fs = require('fs');
const path = require('path');

const cssPath = path.resolve('webapp/src/style.css');
const content = fs.readFileSync(cssPath, 'utf8');
const lines = content.split(/\r?\n/);

console.log('Total lines in style.css:', lines.length);

function getSlice(start, end) {
  // start, end are 1-based inclusive
  return lines.slice(start - 1, end).join('\n') + '\n';
}

const slices = {
  // 1. Base
  'webapp/src/css/base/variables.css': [
    [1, 90]
  ],
  'webapp/src/css/base/reset.css': [
    [91, 114],
    [805, 815] // 无障碍减少动效
  ],
  'webapp/src/css/base/layout.css': [
    [115, 125], // banner
    [126, 155], // topbar
    [156, 163], // app 容器
    [164, 196], // tabbar
    [588, 620], // loading, empty-state, error-state
    [670, 703], // 桌面端通用布局
    [1222, 1246], // v6 沉浸页 app--nobar 与 page-head
    [1740, 1750]  // v6 桌面端媒体查询
  ],

  // 2. Components
  'webapp/src/css/components/buttons.css': [
    [286, 338], // btn, btn--*
    [979, 985]  // 自判按钮
  ],
  'webapp/src/css/components/cards.css': [
    [197, 213]  // card, card__head
  ],
  'webapp/src/css/components/forms.css': [
    // 手机端专项增强中与输入控件相关的
    [1181, 1206]
  ],
  'webapp/src/css/components/chips.css': [
    [339, 369], // chip, chip-group
    [886, 894]  // 同步状态徽标
  ],
  'webapp/src/css/components/modal.css': [
    [704, 726], // Toast
    [727, 779], // Dialog
    [780, 804]  // Van circle
  ],

  // 3. Views
  'webapp/src/views/home.css': [
    [214, 285], // 首页英雄区 + 首页主卡
    [1247, 1411], // 首页 greet, banner, goal, continue-card, quick-grid, subject-list, rec-list
    [1727, 1739]  // v6 首页小屏
  ],
  'webapp/src/views/banks.css': [
    [895, 926], // 题库卡片
    [986, 1072], // 题库选择行
    [1412, 1519] // 题库 tab 与 题库列表
  ],
  'webapp/src/views/wrongbook.css': [
    [1073, 1180], // 错题本重构样式
    [1520, 1582]  // 错题本 KPI 看板
  ],
  'webapp/src/views/me.css': [
    [557, 587], // 统计
    [621, 636], // 小结
    [637, 650], // 设置
    [1583, 1653] // 我的
  ],
  'webapp/src/views/favorites.css': [
    [528, 556], // 列表
    [1654, 1680] // 收藏
  ],
  'webapp/src/views/login.css': [
    [816, 885]  // 登录 / 注册 / 邀请码
  ],

  // 4. Practice-hub
  'webapp/src/views/practice-hub/practice.css': [
    [370, 527], // 刷题页
    [651, 669], // 刷题小屏
    [927, 957], // 填空题
    [958, 978], // 简答题
    [1207, 1221] // 刷题手机端 sticky 底部
  ],
  'webapp/src/views/practice-hub/exam-card.css': [
    [1755, 1906] // 答题卡弹窗 ExamCardSheet 全量样式
  ],
  'webapp/src/views/practice-hub/exam.css': [
    [1681, 1726], // 旧考试模式
    [1751, 1754], // 考试区头部注释
    [1907, 2365]  // 考试全新 Header、进度条、提示卡、吸底栏、出分大看板、题型卡、解析区、筛选分页
  ]
};

// 校验行覆盖情况
const assigned = new Array(lines.length + 1).fill(0);
for (const [file, ranges] of Object.entries(slices)) {
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) {
      if (assigned[i] > 0) {
        console.error(`Conflict at line ${i} for file ${file}`);
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

console.log('Unassigned lines count:', unassigned.length);
if (unassigned.length > 0) {
  console.log('First 20 unassigned:', unassigned.slice(0, 20));
  unassigned.slice(0, 5).forEach(lineNum => {
    console.log(`Line ${lineNum}: ${lines[lineNum - 1]}`);
  });
}
