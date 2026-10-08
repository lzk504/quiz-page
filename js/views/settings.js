/** 设置页：账号 / 数据管理（导入导出清空） / 管理员（邀请码） / 关于 */

import { getMeta, getQuestions, on } from "../state.js";
import {
  exportJson, validateImport, applyImport, clearAll, getStore, isPersistent, getSyncStatus,
} from "../storage.js";
import { getCurrentUser, logout, apiFetch } from "../auth.js";
import { computeStats } from "../stats.js";
import { esc, fmtDate, fmtTime, download } from "../utils.js";
import { toast } from "../ui.js";
import { navigate } from "../router.js";

const ROLE_LABEL = { admin: "管理员", user: "普通用户" };

export default {
  _onSync: null,

  async render(root) {
    const meta = getMeta();
    const questions = getQuestions();
    const store = getStore();
    const s = computeStats(questions, store);
    const user = getCurrentUser();
    const sync = getSyncStatus();
    const recordCount = Object.keys(store.records).length;

    const isAdmin = user?.role === "admin";

    root.innerHTML = `
      <section class="card">
        <h2 class="card__title">账号</h2>
        <div class="about">
          <p>· 当前用户：<b>${esc(user?.username ?? "—")}</b>　·　角色：<b>${esc(ROLE_LABEL[user?.role] ?? user?.role ?? "—")}</b></p>
          <p>· 注册时间：${esc(fmtTime(user?.createdAt))}</p>
          <p>· 数据存储：云端（Cloudflare Workers KV），多设备登录自动同步</p>
        </div>
        <div class="actions" style="margin-top:10px">
          <button class="btn btn--sm btn--danger" id="btnLogout">退出登录</button>
        </div>
      </section>

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
            <span>删除云端保存的全部答题记录与错题本，不可撤销。</span>
          </div>
          <button class="btn btn--sm btn--danger" id="btnClear">清空</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">当前数据 <small>${isPersistent() ? "已同步" : "未同步"}</small></h2>
        <div class="about">
          <p>· 同步状态：<b>${esc(syncLabel(sync))}</b></p>
          <p>· 答题记录 <b>${recordCount}</b> 条　·　错题在册 <b>${s.wrongCount}</b> 题</p>
          <p>· 最近更新：${esc(fmtTime(store.updatedAt))}</p>
        </div>
      </section>

      ${isAdmin ? `
        <section class="card">
          <h2 class="card__title">邀请码管理 <small>仅管理员</small></h2>
          <div class="actions" style="margin-bottom:10px">
            <button class="btn btn--sm btn--primary" id="btnGenInvite">生成新邀请码</button>
            <button class="btn btn--sm" id="btnRefreshInvites">刷新</button>
          </div>
          <div id="inviteList" class="invite-list"><p class="about">加载中…</p></div>
        </section>
      ` : ""}

      <section class="card">
        <h2 class="card__title">关于</h2>
        <div class="about">
          <p><b>${esc(meta?.title ?? "《3-6岁儿童学习与发展指南》刷题手册")}</b></p>
          <p>题库共 ${questions.length} 题，题目与解析取自《3-6 岁儿童学习与发展指南 · 考点精编与刷题手册》。</p>
          <p>数据依据：${esc(meta?.source ?? "教育部《3-6岁儿童学习与发展指南》")}。</p>
          <p>前端纯静态，后端为 Cloudflare Workers + KV；题库以 JSON 文件存放于 <code>data/questions.json</code>。</p>
          <p>版本 v${esc(String(meta?.version ?? 1))}　·　题库生成于 ${esc(meta?.generatedAt ?? "—")}</p>
        </div>
      </section>
    `;

    /* ---------- 账号 ---------- */
    root.querySelector("#btnLogout")?.addEventListener("click", () => {
      if (!window.confirm("确定退出登录吗？退出后需重新登录才能查看答题数据。")) return;
      logout();
      toast("已退出登录", "info");
      navigate("login");
    });

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
      try { text = await f.text(); }
      catch { toast("文件读取失败", "bad"); return; }

      const check = validateImport(text);
      if (!check.ok) { toast(`导入失败：${check.reason}`, "bad"); return; }

      const sum = check.summary;
      const mode = window.confirm(
        `备份校验通过。\n\n` +
        `包含：答题记录 ${sum.records} 条 / 错题 ${sum.wrongbook} 条\n\n` +
        `点「确定」= 覆盖当前数据\n点「取消」= 与当前数据合并（同一题保留时间较新的记录）`
      );
      applyImport(check.store, mode ? "replace" : "merge");
      toast(mode ? "已覆盖导入" : "已合并导入", "ok");
      this.render(root);
    });

    /* ---------- 清空 ---------- */
    root.querySelector("#btnClear")?.addEventListener("click", () => {
      if (!recordCount && !s.wrongCount) { toast("当前没有需要清空的数据", "info"); return; }
      if (!window.confirm("确定要清空全部答题记录与错题本吗？此操作不可撤销。")) return;
      if (!window.confirm("再次确认：清空后无法恢复，确定继续？")) return;
      clearAll();
      toast("已清空所有数据", "ok");
      this.render(root);
    });

    /* ---------- 邀请码 ---------- */
    if (isAdmin) {
      this._loadInvites(root);
      root.querySelector("#btnGenInvite")?.addEventListener("click", async () => {
        try {
          const inv = await apiFetch("/api/invites", { method: "POST" });
          toast("邀请码已生成", "ok");
          this._loadInvites(root);
          // 尝试复制到剪贴板
          try { await navigator.clipboard.writeText(inv.code); toast(`邀请码已复制：${inv.code}`, "ok"); } catch {}
        } catch (e) { toast(e.message || "生成失败", "bad"); }
      });
      root.querySelector("#btnRefreshInvites")?.addEventListener("click", () => this._loadInvites(root));
    }

    /* ---------- 同步状态实时刷新 ---------- */
    if (this._onSync) this._onSync();
    this._onSync = on("sync-status", () => {
      // 仅刷新"当前数据"卡片与顶栏，不整页重渲染（避免打断用户操作）
      const node = root.querySelector(".card:nth-of-type(3) .about p:first-child b");
      if (node) node.textContent = syncLabel(getSyncStatus());
    });
  },

  async _loadInvites(root) {
    const box = root.querySelector("#inviteList");
    if (!box) return;
    try {
      const list = await apiFetch("/api/invites");
      if (!Array.isArray(list) || list.length === 0) {
        box.innerHTML = `<p class="about">暂无邀请码</p>`;
        return;
      }
      box.innerHTML = list.map((inv) => `
        <div class="invite-item">
          <code class="invite-item__code">${esc(inv.code)}</code>
          <span class="invite-item__state ${inv.usedBy ? "is-used" : "is-free"}">
            ${inv.usedBy ? `已用 · ${esc(inv.usedBy)}` : "未使用"}
          </span>
          <span class="invite-item__time">${esc(fmtTime(inv.createdAt))}</span>
        </div>
      `).join("");
      // 点击 code 复制
      box.querySelectorAll(".invite-item__code").forEach((c) => {
        c.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(c.textContent); toast("已复制", "ok"); } catch {}
        });
      });
    } catch (e) {
      box.innerHTML = `<p class="about">加载失败：${esc(e.message || "未知错误")}</p>`;
    }
  },

  unmount() {
    if (this._onSync) { this._onSync(); this._onSync = null; }
  },
};

function syncLabel(sync) {
  if (!sync) return "未知";
  switch (sync.status) {
    case "ok": return "已同步";
    case "pending": return "同步中…";
    case "error": return `失败${sync.error ? "：" + sync.error : ""}`;
    default: return "空闲";
  }
}
