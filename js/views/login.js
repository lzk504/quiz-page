/** 登录/注册视图：双 tab，注册支持邀请码（首位用户可留空） */

import { login, register, isLoggedIn } from "../auth.js";
import { initStorage } from "../storage.js";
import { navigate } from "../router.js";
import { esc } from "../utils.js";
import { toast } from "../ui.js";

export default {
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
                   minlength="8" autocomplete="current-password"
                   placeholder="至少 8 位，含字母和数字">
          </label>

          <label class="field" id="inviteField" hidden>
            <span class="field__label">邀请码</span>
            <input class="field__input" name="inviteCode" type="text"
                   autocomplete="off" placeholder="首位用户可留空">
            <span class="field__hint">系统首个注册用户自动成为管理员，无需邀请码；之后注册需向管理员索取。</span>
          </label>

          <div class="actions">
            <button class="btn btn--primary btn--block" type="submit" id="authSubmit">登录</button>
          </div>
          <p class="auth__note" id="authNote"></p>
        </form>
      </div>

      <section class="card">
        <div class="about">
          <p><b>《3-6 岁儿童学习与发展指南》刷题手册</b></p>
          <p>答题数据保存在云端，登录后多设备同步。请妥善保管你的账号。</p>
        </div>
      </section>
    `;

    let tab = "login";
    const submitBtn = root.querySelector("#authSubmit");
    const passwordInput = root.querySelector('input[name="password"]');
    const inviteField = root.querySelector("#inviteField");

    // tab 切换：直接改 DOM，不 re-render（避免丢失输入与重置 tab 状态）
    root.querySelectorAll(".auth__tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = btn.dataset.tab;
        root.querySelectorAll(".auth__tab").forEach((b) => b.classList.toggle("is-on", b === btn));
        submitBtn.textContent = tab === "login" ? "登录" : "注册并登录";
        passwordInput.autocomplete = tab === "login" ? "current-password" : "new-password";
        inviteField.hidden = tab !== "register";
      });
    });

    const form = root.querySelector("#authForm");
    const note = root.querySelector("#authNote");

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
        // 登录/注册成功后拉取云端数据填充 cache
        await initStorage();
        navigate("home");
      } catch (err) {
        note.textContent = esc(err?.message || "操作失败");
        note.classList.add("auth__note--err");
      } finally {
        submitBtn.disabled = false;
      }
    });
  },
};
