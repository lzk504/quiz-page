/** 设置页：导出 / 导入 / 清空 / 关于 */

import { getMeta, getQuestions } from "../state.js";
import {
  exportJson, validateImport, applyImport, clearAll, getStore, isPersistent, STORE_KEY,
} from "../storage.js";
import { computeStats } from "../stats.js";
import { esc, fmtDate, fmtTime, download } from "../utils.js";
import { toast } from "../ui.js";

export default {
  async render(root) {
    const meta = getMeta();
    const questions = getQuestions();
    const store = getStore();
    const s = computeStats(questions, store);
    const persistent = isPersistent();

    const recordCount = Object.keys(store.records).length;

    root.innerHTML = `
      <section class="card">
        <h2 class="card__title">数据管理</h2>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>导出备份</b>
            <span>下载 JSON 文件，包含答题记录与错题本。换设备或清缓存前建议导出一份。</span>
          </div>
          <button class="btn btn--sm btn--primary" id="btnExport">导出</button>
        </div>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>导入备份</b>
            <span>从之前导出的 JSON 文件恢复（兼容 v1 旧备份，会自动迁移）。导入前会自动校验格式，失败不会改动现有数据。</span>
          </div>
          <button class="btn btn--sm" id="btnImport">导入</button>
          <input type="file" id="fileInput" accept="application/json,.json" hidden>
        </div>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>清空所有数据</b>
            <span>删除本机保存的全部答题记录与错题本，不可撤销。</span>
          </div>
          <button class="btn btn--sm btn--danger" id="btnClear">清空</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">当前数据 <small>${persistent ? "已保存到本机" : "未持久化"}</small></h2>
        <div class="about">
          <p>· 存储位置：<code>localStorage["${esc(STORE_KEY)}"]</code>${persistent ? "" : "（当前不可用，仅本次会话有效）"}</p>
          <p>· 答题记录 <b>${recordCount}</b> 条　·　错题在册 <b>${s.wrongCount}</b> 题</p>
          <p>· 最近更新：${esc(fmtTime(store.updatedAt))}</p>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">关于</h2>
        <div class="about">
          <p><b>${esc(meta?.title ?? "《3-6岁儿童学习与发展指南》刷题手册")}</b></p>
          <p>题库共 ${questions.length} 题，题目与解析取自《3-6 岁儿童学习与发展指南 · 考点精编与刷题手册》。</p>
          <p>数据依据：${esc(meta?.source ?? "教育部《3-6岁儿童学习与发展指南》")}。</p>
          <p>纯静态应用：题库以 JSON 文件存放于 <code>data/questions.json</code>，全部在前端加载与判分，不依赖任何后端服务，可直接部署到静态托管平台。</p>
          <p>版本 v${esc(String(meta?.version ?? 1))}　·　题库生成于 ${esc(meta?.generatedAt ?? "—")}</p>
        </div>
      </section>
    `;

    /* ---------- 导出 ---------- */
    root.querySelector("#btnExport")?.addEventListener("click", () => {
      download(`quiz-backup-${fmtDate()}.json`, exportJson());
      toast("备份已导出", "ok");
    });

    /* ---------- 导入 ---------- */
    const file = root.querySelector("#fileInput");
    root.querySelector("#btnImport")?.addEventListener("click", () => file.click());

    file?.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;

      let text;
      try {
        text = await f.text();
      } catch {
        toast("文件读取失败", "bad");
        return;
      }

      const check = validateImport(text);
      if (!check.ok) {
        toast(`导入失败：${check.reason}`, "bad");
        return;
      }

      const sum = check.summary;
      const mode = window.confirm(
        `备份校验通过。\n\n` +
        `包含：答题记录 ${sum.records} 条 / 错题 ${sum.wrongbook} 条` +
        (sum.legacyRecite ? `\n（旧版背诵记录 ${sum.legacyRecite} 条将不再使用）` : "") + `\n\n` +
        `点「确定」= 覆盖当前数据\n点「取消」= 与当前数据合并（同一题保留时间较新的记录）`
      );
      applyImport(check.store, mode ? "replace" : "merge");
      toast(mode ? "已覆盖导入" : "已合并导入", "ok");
      this.render(root);
    });

    /* ---------- 清空 ---------- */
    root.querySelector("#btnClear")?.addEventListener("click", () => {
      if (!recordCount && !s.wrongCount) {
        toast("当前没有需要清空的数据", "info");
        return;
      }
      if (!window.confirm("确定要清空全部答题记录与错题本吗？此操作不可撤销。")) return;
      if (!window.confirm("再次确认：清空后无法恢复，确定继续？")) return;
      clearAll();
      toast("已清空所有数据", "ok");
      this.render(root);
    });
  },
};
