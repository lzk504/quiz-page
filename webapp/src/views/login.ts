import "./login.css";
import { login, register, isLoggedIn } from "../auth";
import { initStorage } from "../storage";
import { startSync } from "../sync";
import { navigate } from "../router";
import { esc } from "../utils";
import { toast } from "../ui";
import type { View } from "../types";

const view: View = {
  async render(root) {
    if (isLoggedIn()) { navigate("home"); return; }

    root.innerHTML = `
      <div class="card auth">
        <div class="auth__tabs" role="tablist">
          <button class="auth__tab is-on" data-tab="login" type="button">登录</button>
          <button class="auth__tab" data-tab="register" type="button">注册</button>
        </div>

        <form class="auth__form" id="authForm" autocomplete="on">
          <label class="field">
            <span class="field__label">用户名</span>
            <input class="field__input" name="username" type="text" required
                   minlength="3" maxlength="32"
                   autocomplete="username" placeholder="3-32 位字母、数字、下划线、短横线">
          </label>

          <label class="field">
            <span class="field__label">密码</span>
            <input class="field__input" name="password" type="password" required
                   autocomplete="current-password"
                   placeholder="需包含至少一个大写字母">
          </label>

          <label class="field" id="inviteField" hidden>
            <span class="field__label">邀请码</span>
            <input class="field__input" name="inviteCode" type="text"
                   autocomplete="off" placeholder="请输入邀请码">
            <span class="field__hint">注册需邀请码，请联系管理员获取。</span>
          </label>

          <p class="field__hint first-user-hint" id="firstUserHint" hidden>首位注册用户将成为系统管理员，无需邀请码。</p>

          <div class="actions">
            <button class="btn btn--primary btn--block" type="submit" id="authSubmit">登录</button>
          </div>
          <p class="auth__note" id="authNote"></p>
        </form>
      </div>
    `;

    let tab: "login" | "register" = "login";
    let initialized = false;   // 系统是否已有用户（首用户场景隐藏邀请码字段）
    const submitBtn = root.querySelector<HTMLButtonElement>("#authSubmit")!;
    const passwordInput = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    const inviteField = root.querySelector<HTMLElement>("#inviteField")!;
    const firstUserHint = root.querySelector<HTMLElement>("#firstUserHint")!;

    function applyTabUI(): void {
      submitBtn.textContent = tab === "login" ? "登录" : "注册并登录";
      passwordInput.autocomplete = tab === "login" ? "current-password" : "new-password";
      inviteField.hidden = !(initialized && tab === "register");
      firstUserHint.hidden = !(tab === "register" && !initialized);
    }
    applyTabUI();

    // tab 切换：直接改 DOM，不 re-render（避免丢失输入与重置 tab 状态）
    root.querySelectorAll<HTMLButtonElement>(".auth__tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = (btn.dataset.tab as "login" | "register") || "login";
        root.querySelectorAll(".auth__tab").forEach((b) => b.classList.toggle("is-on", b === btn));
        applyTabUI();
      });
    });

    // 探测系统初始化状态：未初始化时隐藏邀请码字段，提示"首位将成为管理员"
    fetch("/api/bootstrap")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { initialized?: boolean } | null) => { initialized = !!(d && d.initialized); applyTabUI(); })
      .catch(() => { /* 探测失败按未初始化处理 */ });

    const form = root.querySelector<HTMLFormElement>("#authForm")!;
    const note = root.querySelector<HTMLElement>("#authNote")!;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "");
      const inviteCode = tab === "register" ? String(fd.get("inviteCode") || "").trim() : undefined;

      if (!username || !password) { toast("请填写用户名和密码", "bad"); return; }

      submitBtn.disabled = true;
      note.textContent = "处理中…";
      note.classList.remove("auth__note--err");

      try {
        if (tab === "login") {
          await login(username, password);
          toast("登录成功", "ok");
        } else {
          await register(username, password, inviteCode);
          toast("注册成功", "ok");
        }
        // 登录/注册成功后拉取云端数据填充 cache 并开启同步
        await initStorage();
        startSync();
        navigate("home");
      } catch (err) {
        note.textContent = esc((err as Error)?.message || "操作失败");
        note.classList.add("auth__note--err");
      } finally {
        submitBtn.disabled = false;
      }
    });
  },
};

export default view;
