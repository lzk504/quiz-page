/** 功能设置页：账号（昵称） / 数据管理（导入导出清空） / 管理员（邀请码 / 全量备份） / 关于 */

import { getMeta, getQuestions, getBanks, on } from "../state";
import {
  exportJson, validateImport, applyImport, clearAll, getStore, isPersistent, getSyncStatus,
  flushStore, getNickname, setNickname, NICKNAME_MAX, SCHEMA_VERSION,
} from "../storage";
import { getCurrentUser, logout, apiFetch } from "../auth";
import { stopSync } from "../sync";
import { computeStats } from "../stats";
import { esc, fmtDate, fmtTime, download } from "../utils";
import { toast } from "../ui";
import { navigate } from "../router";
import type { Invite, SyncStatus, View } from "../types";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", user: "普通用户" };

function syncLabel(sync: SyncStatus | null | undefined): string {
  if (!sync) return "未知";
  switch (sync.status) {
    case "ok": return "已同步";
    case "pending": return "同步中…";
    case "error": return `失败${sync.error ? "：" + sync.error : ""}`;
    default: return "空闲";
  }
}

let offSync: (() => void) | null = null;

const view: View = {
  async render(root) {
    if (offSync) { offSync(); offSync = null; }

    const meta = getMeta();
    const questions = getQuestions();
    const banks = getBanks();
    const store = getStore();
    const s = computeStats(questions, store);
    const user = getCurrentUser();
    const sync = getSyncStatus();
    const recordCount = Object.keys(store.records).length;
    const isAdmin = user?.role === "admin";

    root.innerHTML = `
      <div class="page-head">
        <button class="page-head__back" id="setBack" title="返回">‹</button>
        <h1 class="page-head__title">功能设置</h1>
      </div>

      <section class="card">
        <h2 class="card__title">账号</h2>
        <div class="about">
          <p>· 当前用户：<b>${esc(user?.username ?? "—")}</b>　·　角色：<b>${esc(ROLE_LABEL[user?.role ?? ""] ?? user?.role ?? "—")}</b></p>
          <p>· 注册时间：${esc(fmtTime(user?.createdAt))}</p>
          <p>· 数据存储：云端（Cloudflare D1），多设备登录自动同步</p>
        </div>
        <div class="setting-row">
          <div class="setting-row__text">
            <b>昵称</b>
            <span>显示在首页问候语中，未设置时显示用户名；最长 ${NICKNAME_MAX} 个字符。</span>
          </div>
          <input class="field__input" id="setNickname" type="text" maxlength="${NICKNAME_MAX}"
            placeholder="未设置" value="${esc(getNickname())}" style="width:120px;flex:none">
          <button class="btn btn--sm btn--primary" id="btnSaveNick">保存</button>
        </div>
        <div class="actions" style="margin-top:10px">
          <button class="btn btn--sm btn--danger" id="btnLogout">退出登录</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">数据管理</h2>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>导出我的备份</b>
            <span>下载 JSON 文件，包含你的答题记录与错题本。</span>
          </div>
          <button class="btn btn--sm btn--primary" id="btnExport">导出</button>
        </div>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>导入备份</b>
            <span>从之前导出的 JSON 文件恢复（兼容 v1/v2/v3 旧备份，会自动迁移到 v${SCHEMA_VERSION}）。导入前会自动校验格式，失败不会改动现有数据。</span>
          </div>
          <button class="btn btn--sm" id="btnImport">导入</button>
          <input type="file" id="fileInput" accept="application/json,.json" hidden>
        </div>

        <div class="setting-row">
          <div class="setting-row__text">
            <b>清空我的数据</b>
            <span>删除云端保存的全部答题记录与错题本，不可撤销。</span>
          </div>
          <button class="btn btn--sm btn--danger" id="btnClear">清空</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">当前数据 <small>${isPersistent() ? "已同步" : "未同步"}</small></h2>
        <div class="about">
          <p>· 同步状态：<b id="syncState">${esc(syncLabel(sync))}</b></p>
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

        <section class="card">
          <h2 class="card__title">全量备份 <small>仅管理员</small></h2>
          <div class="setting-row" style="padding-top:0">
            <div class="setting-row__text">
              <b>导出整站数据</b>
              <span>下载所有用户的账号、邀请码与刷题数据（JSON）。该文件含密码哈希，请妥善保管。</span>
            </div>
            <button class="btn btn--sm btn--primary" id="btnBackupAll">导出全量</button>
          </div>
        </section>
      ` : ""}

      <section class="card">
        <h2 class="card__title">关于</h2>
        <div class="about">
          <p><b>考点精编 · 学前教育备考</b></p>
          <p>共 ${banks.length} 个题库（已加载 ${questions.length} 题）：${banks.map((b) => esc(b.title)).join("　")}</p>
          <p>四个标签页：首页（今日目标 / 考试模式 / 今日推荐复习）、题库（章节目录与题型专项）、错题本、我的（统计报告与设置）。</p>
          <p>前端 TypeScript + Vite 构建，后端 Cloudflare Workers + D1；题库以 JSON 存放于 <code>data/banks.json</code> 与 <code>data/bank-*.json</code>。</p>
          <p>数据版本 v${SCHEMA_VERSION}（含收藏与昵称）　·　共 ${banks.length} 库 / 每库 1000 题</p>
        </div>
      </section>
    `;

    /* ---------- 账号 ---------- */
    root.querySelector("#setBack")?.addEventListener("click", () => navigate("me"));
    root.querySelector("#btnSaveNick")?.addEventListener("click", () => {
      const input = root.querySelector<HTMLInputElement>("#setNickname");
      const nick = setNickname(input?.value ?? "");
      toast(nick ? `昵称已保存：${nick}` : "已清除昵称，将显示用户名", "ok");
      void view.render(root);
    });
    root.querySelector("#btnLogout")?.addEventListener("click", () => {
      if (!window.confirm("确定退出登录吗？退出后需重新登录才能查看答题数据。")) return;
      // 先冲刷待发数据：作答后的上云是 800ms 防抖的，直接 logout 会清掉 token
      // 导致 doPut() 提前返回，最近一次作答/导入就永远丢了。
      flushStore();
      stopSync();
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
    const file = root.querySelector<HTMLInputElement>("#fileInput");
    root.querySelector("#btnImport")?.addEventListener("click", () => file?.click());

    file?.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;

      let text: string;
      try { text = await f.text(); }
      catch { toast("文件读取失败", "bad"); return; }

      const check = validateImport(text);
      if (!check.ok || !check.store) { toast(`导入失败：${check.reason}`, "bad"); return; }

      const sum = check.summary!;
      const mode = window.confirm(
        `备份校验通过。\n\n` +
        `包含：答题记录 ${sum.records} 条 / 错题 ${sum.wrongbook} 条 / 收藏 ${sum.favorites} 条\n\n` +
        `点「确定」= 覆盖当前数据\n点「取消」= 与当前数据合并（同一题保留时间较新的记录）`
      );
      applyImport(check.store, mode ? "replace" : "merge");
      toast(mode ? "已覆盖导入" : "已合并导入", "ok");
      void view.render(root);
    });

    /* ---------- 清空 ---------- */
    root.querySelector("#btnClear")?.addEventListener("click", () => {
      if (!recordCount && !s.wrongCount) { toast("当前没有需要清空的数据", "info"); return; }
      if (!window.confirm("确定要清空全部答题记录与错题本吗？此操作不可撤销。")) return;
      if (!window.confirm("再次确认：清空后无法恢复，确定继续？")) return;
      clearAll();
      toast("已清空所有数据", "ok");
      void view.render(root);
    });

    /* ---------- 邀请码 ---------- */
    if (isAdmin) {
      void loadInvites(root);
      root.querySelector("#btnGenInvite")?.addEventListener("click", async () => {
        try {
          const inv = await apiFetch<Invite>("/api/invites", { method: "POST" });
          toast("邀请码已生成", "ok");
          void loadInvites(root);
          try { await navigator.clipboard.writeText(inv.code); toast(`邀请码已复制：${inv.code}`, "ok"); } catch { /* 剪贴板不可用 */ }
        } catch (e) { toast((e as Error).message || "生成失败", "bad"); }
      });
      root.querySelector("#btnRefreshInvites")?.addEventListener("click", () => { void loadInvites(root); });

      /* ---------- 全量备份 ---------- */
      root.querySelector("#btnBackupAll")?.addEventListener("click", async () => {
        try {
          const data = await apiFetch<unknown>("/api/admin/backup");
          download(`quiz-full-backup-${fmtDate()}.json`, JSON.stringify(data, null, 2));
          toast("全量备份已导出", "ok");
        } catch (e) { toast((e as Error).message || "导出失败", "bad"); }
      });
    }

    /* ---------- 同步状态实时刷新 ---------- */
    offSync = on("sync-status", () => {
      const node = root.querySelector("#syncState");
      if (node) node.textContent = syncLabel(getSyncStatus());
    });
  },

  unmount() {
    if (offSync) { offSync(); offSync = null; }
  },
};

async function loadInvites(root: HTMLElement): Promise<void> {
  const box = root.querySelector("#inviteList");
  if (!box) return;
  try {
    const list = await apiFetch<Invite[]>("/api/invites");
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
    box.querySelectorAll<HTMLElement>(".invite-item__code").forEach((c) => {
      c.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(c.textContent || ""); toast("已复制", "ok"); } catch { /* ignore */ }
      });
    });
  } catch (e) {
    box.innerHTML = `<p class="about">加载失败：${esc((e as Error).message || "未知错误")}</p>`;
  }
}

export default view;
