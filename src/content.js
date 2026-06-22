// 内容脚本：检测登录表单，提供账号提示下拉、自动回填密码、保存新凭据。
(() => {
  "use strict";

  // 动态注册 + 授权后即时注入可能导致同一页面注入两次，加载守卫避免重复绑定。
  if (window.__easyPasswordLoaded) return;
  window.__easyPasswordLoaded = true;

  // 用 host（含端口）作站点标识，兼容内网「IP:端口」场景（无域名时端口可区分不同应用）。
  const DOMAIN = location.host || location.hostname;
  const i18n = (key, subs) => chrome.i18n.getMessage(key, subs);
  let dropdown = null;
  let activeUserField = null;
  let suggestionItems = [];
  let activeIndex = -1;

  // ---------- 与后台通信 ----------
  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // ---------- 表单探测 ----------
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 多语言匹配词表（改编自 Chromium components/autofill 的正则思路，BSD-3-Clause）。
  // 分层判定：autocomplete 属性最权威 → 字段文本(含 label/aria) → 命名/结构兜底。
  const RE = {
    passlike: /pass(word)?|passwd|pwd|密\s*码|secret/i,
    // 新密码（注册/改密/确认）
    newpass: /new[\s._-]*pass|re[\s._-]*(type|enter)|retype|repeat|confirm|again|verify[\s._-]*pass|注册|新密码|确认密码|再次|重复|设置密码|两次|修改密码|更改密码/i,
    // 当前/登录密码
    curpass: /current[\s._-]*pass|old[\s._-]*pass|login[\s._-]*pass|sign[\s._-]*in[\s._-]*pass|登录密码|当前密码|原密码|旧密码/i,
    // 账号/用户名/邮箱/手机
    username: /user(name)?|account|login|email|e-mail|phone|mobile|\btel\b|用户名|用户|账号|帐号|账户|登录名|邮箱|手机号?|电话/i,
    // 排除：搜索、验证码、找回等非账号/非密码
    negAccount: /search|搜索|query|captcha|verif|\bcode\b|otp|短信|验证码/i,
  };

  // 收集字段的「可读文本」：关联 label、aria-label/labelledby、placeholder + 命名/类名。
  function labelText(el) {
    let s = "";
    try {
      const root = el.getRootNode();
      if (el.id && root.querySelector) {
        const lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) s += " " + lab.textContent;
      }
      const wrap = el.closest && el.closest("label");
      if (wrap) s += " " + wrap.textContent;
      const lb = el.getAttribute && el.getAttribute("aria-labelledby");
      if (lb) lb.split(/\s+/).forEach((id) => {
        const n = (root.getElementById && root.getElementById(id)) || document.getElementById(id);
        if (n) s += " " + n.textContent;
      });
    } catch {
      /* CSS.escape 不可用或选择器异常时忽略 */
    }
    return s;
  }

  function fieldText(el) {
    return (
      (el.name || "") + " " + (el.id || "") + " " + (el.className || "") + " " +
      (el.placeholder || "") + " " + (el.getAttribute("aria-label") || "") + " " + labelText(el)
    ).slice(0, 400).toLowerCase();
  }

  // 判断是否「密码框」：原生 type=password，或自定义密码框（autocomplete 或字段文本命中）。
  function isPasswordLike(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const type = (el.type || "").toLowerCase();
    if (type === "password") return true;
    if (type && type !== "text") return false; // email/tel/number 等不算密码
    const ac = (el.autocomplete || "").toLowerCase();
    if (ac.includes("current-password") || ac.includes("new-password")) return true;
    return RE.passlike.test(fieldText(el));
  }

  // 深度查询：递归进入 open shadow DOM，覆盖自定义组件里的输入框。
  function deepQueryAll(selector, root, out) {
    root = root || document;
    out = out || [];
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  function getPasswordFields() {
    return deepQueryAll("input").filter((el) => isPasswordLike(el) && isVisible(el));
  }

  // 「登录账号框」：手机/邮箱/用户名等(支持无密码的验证码登录)。排除搜索框、验证码框。
  // 分层：autocomplete 权威 → 字段文本(含 label)。
  function isAccountField(el) {
    if (!el || el.tagName !== "INPUT" || !isVisible(el) || isPasswordLike(el)) return false;
    const type = (el.type || "").toLowerCase();
    if (type && !["text", "email", "tel"].includes(type)) return false;
    const ac = (el.autocomplete || "").toLowerCase();
    if (/username|email|tel/.test(ac)) return true; // autocomplete 权威
    const hay = fieldText(el);
    if (RE.negAccount.test(hay)) return false; // 搜索/验证码等排除
    if (type === "email" || type === "tel") return true;
    return RE.username.test(hay);
  }

  function getAccountFields() {
    return deepQueryAll("input").filter(isAccountField);
  }

  // 找到与某个密码框关联的账号输入框：同表单/同根（含 shadow root）内、位于密码框之前、最近的文本/邮箱/电话输入框。
  function findUserFieldFor(passwordField) {
    const scope = passwordField.form || passwordField.getRootNode();
    const candidates = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
      )
    ).filter((c) => isVisible(c) && !isPasswordLike(c)); // 排除被当作密码的文本框
    if (candidates.length === 0) return null;

    // 优先 autocomplete=username
    const byAuto = candidates.find((c) => (c.autocomplete || "").includes("username"));
    if (byAuto) return byAuto;

    // 取 DOM 顺序中位于密码框之前、距离最近的一个
    const all = Array.from(scope.querySelectorAll("input"));
    const pwIndex = all.indexOf(passwordField);
    let best = null;
    for (const c of candidates) {
      const idx = all.indexOf(c);
      if (idx < pwIndex) best = c; // 不断向后取，最终得到最接近密码框的那个
    }
    return best || candidates[0];
  }

  // 返回所有 [userField, passwordField] 配对。
  function getPairs() {
    const pairs = [];
    for (const pw of getPasswordFields()) {
      const user = findUserFieldFor(pw);
      if (user) pairs.push({ user, pw });
    }
    return pairs;
  }

  function passwordFieldForUser(userField) {
    const pair = getPairs().find((p) => p.user === userField);
    return pair ? pair.pw : null;
  }

  // ---------- 原生赋值（触发框架的 input 监听）----------
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillPasswordFor(userField, username) {
    const res = await send("GET_PASSWORD", { domain: DOMAIN, username });
    if (res && res.ok) {
      const pw = passwordFieldForUser(userField);
      if (pw) {
        setNativeValue(pw, res.password);
        return true;
      }
    }
    return false;
  }

  // 落地自动填充：登录页且账号框为空时，自动填入本域账号（多账号取最近用过的，下拉可切换）。
  async function autofillFor(userField) {
    if (!userField || userField.dataset.epAutofilled) return;
    if ((userField.value || "").trim()) return; // 不覆盖已有输入
    const pws = getPasswordFields();
    if (pws.some((pw) => looksLikeNewPassword(pw, pws))) return; // 注册/改密页不自动填
    const st = await send("GET_AUTH_STATE");
    if (!st || !st.configured) {
      userField.dataset.epAutofilled = "1"; // 未配置：不再尝试
      return;
    }
    if (!st.unlocked) return; // 锁定：解锁后（聚焦时）再试
    const res = await send("GET_SUGGESTIONS", { domain: DOMAIN, prefix: "" });
    const list = Array.isArray(res) ? res : [];
    userField.dataset.epAutofilled = "1"; // 已问过后台，避免重复请求
    if (!list.length) return;
    setNativeValue(userField, list[0].username); // list[0] = 最近使用
    await fillPasswordFor(userField, list[0].username);
    hideDropdown(); // 第 6 条：自动填充后收起浮层，别一直挂着
  }

  // ---------- 下拉框 UI ----------
  function ensureDropdown() {
    if (dropdown) return dropdown;
    dropdown = document.createElement("div");
    dropdown.className = "ep-dropdown";
    dropdown.setAttribute("data-ep", "1");
    document.documentElement.appendChild(dropdown);
    return dropdown;
  }

  function hideDropdown() {
    if (dropdown) dropdown.style.display = "none";
    activeIndex = -1;
    suggestionItems = [];
  }

  function positionDropdown(field) {
    const rect = field.getBoundingClientRect();
    const dd = ensureDropdown();
    dd.style.position = "fixed";
    dd.style.left = rect.left + "px";
    dd.style.top = rect.bottom + 2 + "px";
    dd.style.minWidth = rect.width + "px";
  }

  function renderDropdown(field, items) {
    const dd = ensureDropdown();
    dd.innerHTML = "";
    suggestionItems = items;
    activeIndex = -1;
    if (!items.length) {
      hideDropdown();
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "ep-item";
      row.textContent = item.username;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 防止 field 失焦
        chooseSuggestion(field, i);
      });
      row.addEventListener("mouseenter", () => setActive(i));
      dd.appendChild(row);
    });
    const hint = document.createElement("div");
    hint.className = "ep-hint";
    hint.textContent = i18n("dropdown_hint");
    dd.appendChild(hint);

    positionDropdown(field);
    dd.style.display = "block";
  }

  function setActive(i) {
    activeIndex = i;
    const rows = dropdown ? dropdown.querySelectorAll(".ep-item") : [];
    rows.forEach((r, idx) => r.classList.toggle("ep-active", idx === i));
  }

  async function chooseSuggestion(field, i) {
    const item = suggestionItems[i];
    if (!item) return;
    setNativeValue(field, item.username);
    hideDropdown();
    await fillPasswordFor(field, item.username);
  }

  // ---------- 账号框交互 ----------
  let inputDebounce = null;
  async function handleUserInput(field) {
    activeUserField = field;
    const prefix = field.value || "";
    const res = await send("GET_SUGGESTIONS", { domain: DOMAIN, prefix });
    const list = Array.isArray(res) ? res : [];

    // 第 6 条：当前值已等于唯一候选（多为自动填充后聚焦）→ 不再弹浮层，回填密码即可。
    const exact = list.find((x) => x.username === field.value);
    if (exact && list.length === 1) {
      hideDropdown();
      await fillPasswordFor(field, exact.username);
      return;
    }

    renderDropdown(field, list);
    if (exact) {
      await fillPasswordFor(field, exact.username);
    }
  }

  function attach(field) {
    if (field.dataset.epBound) return;
    field.dataset.epBound = "1";

    field.addEventListener("focus", async () => {
      activeUserField = field;
      const st = await send("GET_AUTH_STATE");
      if (!st || !st.configured) return; // 未创建主账户：不打扰页面
      if (!st.unlocked) {
        const he = await send("HAS_ENTRIES", { domain: DOMAIN });
        if (he && he.count > 0) showUnlockBanner(i18n("banner_locked_hint"));
        return;
      }
      autofillFor(field); // 解锁后聚焦也尝试一次自动填充（覆盖加载时仍锁定的情况）
      handleUserInput(field);
    });
    field.addEventListener("input", () => {
      clearTimeout(inputDebounce);
      inputDebounce = setTimeout(() => handleUserInput(field), 80);
    });
    field.addEventListener("keydown", (e) => {
      if (!dropdown || dropdown.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(Math.min(activeIndex + 1, suggestionItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(Math.max(activeIndex - 1, 0));
      } else if (e.key === "Enter") {
        if (activeIndex >= 0) {
          e.preventDefault();
          chooseSuggestion(field, activeIndex);
        }
      } else if (e.key === "Escape") {
        hideDropdown();
      }
    });
    field.addEventListener("blur", () => {
      // 延迟隐藏，给点击下拉项留出时间
      setTimeout(hideDropdown, 150);
    });
  }

  // ---------- 保存新凭据（捕获 → 触发 模型）----------
  let lastSaved = "";
  const capSig = (d, u, p) => d + "|" + u + "|" + p;

  // 真正决定「要不要弹保存」：检查锁定 / 是否已存 / 去重，再弹卡片。密码可为空（仅记账号）。
  // domain 默认当前页，但跨导航时用「捕获时的域名」，避免登录后跳转把端口丢了。
  async function maybeSave(username, password, domain, fullUrl) {
    username = (username || "").trim();
    password = password || "";
    domain = domain || DOMAIN;
    if (!username) return;
    const sig = capSig(domain, username, password);
    if (sig === lastSaved) return;

    const st = await send("GET_AUTH_STATE");
    if (!st || !st.configured) return;
    if (!st.unlocked) {
      showUnlockBanner(i18n("banner_locked_save_hint"));
      return;
    }
    const existing = await send("GET_PASSWORD", { domain, username });
    if (password) {
      // 有密码：已存且相同则跳过
      if (existing && existing.ok && existing.password === password) {
        lastSaved = sig;
        return;
      }
    } else {
      // 仅账号：该账号已记录（无论有无密码）就不再打扰
      if (existing && existing.exists) {
        lastSaved = sig;
        return;
      }
    }
    showSaveBanner(username, password, sig, domain, fullUrl);
  }

  // 当前一次登录的快照：优先「账号+密码」；无密码框时退而取「已填的登录账号」（手机/邮箱）。
  // 一并记录捕获时的域名（含端口），保证保存与抓取用同一个标识。
  function captureLogin() {
    const fullUrl = location.href; // 完整登录页 URL（模块一：一键直达用）

    // 一、账号 + 密码都填了 → 完整保存。
    const filled = filledPair();
    if (filled) {
      return { anchor: filled.pw, username: (filled.user.value || "").trim(), password: filled.pw.value || "", domain: DOMAIN, fullUrl };
    }

    // 二、账号填了但密码为空（即便页面有空密码框，如 root 无密码登录）→ 仅记账号。
    const userPair = getPairs().find((p) => (p.user.value || "").trim());
    if (userPair) {
      return { anchor: userPair.user, username: (userPair.user.value || "").trim(), password: "", domain: DOMAIN, fullUrl };
    }

    // 三、没有密码框、只有登录账号框（手机/邮箱+验证码）→ 仅记账号。
    const af = getAccountFields().find((el) => (el.value || "").trim());
    if (af) return { anchor: af, username: af.value.trim(), password: "", domain: DOMAIN, fullUrl };

    return null;
  }

  // 监测「提交动作」后是否成功：表单/密码框消失或 URL 变化 = 成功 → 提示；
  // 超时仍停留原页且密码框还在 = 大概率失败 → 不提示（避免保存错密码）。
  let activeWatch = null;
  function watchForSuccess(cap) {
    if (activeWatch) activeWatch();
    const startURL = location.href;
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      cleanup();
      send("CLEAR_PENDING", { domain: cap.domain }); // 同页已定论，跨页 pending 不再需要
      if (success) maybeSave(cap.username, cap.password, cap.domain, cap.fullUrl);
    };
    const gone = () => !document.contains(cap.anchor) || !isVisible(cap.anchor) || location.href !== startURL;
    const obs = new MutationObserver(() => { if (gone()) finish(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const iv = setInterval(() => { if (location.href !== startURL) finish(true); }, 300);
    const to = setTimeout(() => finish(gone()), 2200);
    function cleanup() { obs.disconnect(); clearInterval(iv); clearTimeout(to); activeWatch = null; }
    activeWatch = () => { if (!settled) { settled = true; cleanup(); } };
  }

  // 识别到一次「提交动作」：把凭据交给后台跨导航暂存，并启动同页成功监测。
  function noteSubmitAttempt() {
    const cap = captureLogin();
    if (!cap || capSig(cap.domain, cap.username, cap.password) === lastSaved) return;
    // 跨页：成功跳转后由目标页读取 pending 再提示（整页刷新登录靠这条）。
    send("STASH_PENDING", { domain: cap.domain, username: cap.username, password: cap.password, fullUrl: cap.fullUrl });
    watchForSuccess(cap);
  }

  // 统一的卡片式提示条：图标 + 整行文案在上，操作按钮右对齐在下。
  function buildBanner(title, message, buttons) {
    const old = document.querySelector(".ep-banner");
    if (old) old.remove();

    const banner = document.createElement("div");
    banner.className = "ep-banner";
    banner.setAttribute("data-ep", "1");

    const row = document.createElement("div");
    row.className = "ep-banner-row";

    const icon = document.createElement("span");
    icon.className = "ep-banner-icon";
    icon.textContent = "🔐";

    const body = document.createElement("div");
    body.className = "ep-banner-body";
    const head = document.createElement("div");
    head.className = "ep-banner-title";
    head.textContent = title;
    const text = document.createElement("div");
    text.className = "ep-banner-text";
    text.textContent = message;
    body.appendChild(head);
    body.appendChild(text);

    row.appendChild(icon);
    row.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "ep-banner-actions";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = "ep-btn" + (b.primary ? " ep-btn-primary" : "");
      btn.textContent = b.label;
      btn.addEventListener("click", () => b.onClick(banner));
      actions.appendChild(btn);
    }

    banner.appendChild(row);
    banner.appendChild(actions);
    document.documentElement.appendChild(banner);
    return banner;
  }

  function showSaveBanner(username, password, sig, domain, fullUrl) {
    domain = domain || DOMAIN;
    const accountOnly = !password;
    const message = accountOnly ? i18n("banner_save_account_msg", [username]) : i18n("banner_save_msg", [username]);
    const saveLabel = accountOnly ? i18n("btn_remember") : i18n("btn_save");
    const banner = buildBanner(i18n("banner_save_title"), message, [
      {
        label: saveLabel,
        primary: true,
        onClick: async (b) => {
          await send("SAVE_CREDENTIAL", { domain, username, password, fullUrl: fullUrl || location.href });
          lastSaved = sig;
          b.remove();
        },
      },
      { label: i18n("btn_ignore"), onClick: (b) => { lastSaved = sig; b.remove(); } },
    ]);
    setTimeout(() => banner.remove(), 15000);
  }

  let unlockBannerShownAt = 0;
  function showUnlockBanner(message) {
    // 限流：避免每次聚焦都弹（10 秒内只弹一次）。
    if (Date.now() - unlockBannerShownAt < 10000) return;
    unlockBannerShownAt = Date.now();

    const banner = buildBanner(i18n("banner_locked_title"), message, [
      { label: i18n("btn_got_it"), primary: true, onClick: (b) => b.remove() },
    ]);
    setTimeout(() => banner.remove(), 12000);
  }

  // ---------- 强密码生成器（改密/注册场景） ----------
  // 是否「新密码框」（注册/改密场景才弹生成器）。默认保守：登录页（单个密码框）不弹。
  // 是否「新密码框」（注册/改密才弹生成器）。分层：autocomplete 权威 → 字段文本 → 结构。
  function looksLikeNewPassword(pw, allPw) {
    const ac = (pw.autocomplete || "").toLowerCase();
    if (ac.includes("current-password")) return false; // 权威：登录密码 → 不弹
    if (ac.includes("new-password")) return true; // 权威：新密码 → 弹

    const hay = fieldText(pw);
    if (RE.curpass.test(hay)) return false; // 文本指向登录/当前密码 → 不弹
    if (RE.newpass.test(hay)) return true; // 文本指向注册/改密/确认 → 弹

    // 真正的 type=password 框 ≥2 个（密码 + 确认密码）→ 注册/改密 → 弹
    const realPw = (allPw || []).filter((p) => (p.type || "").toLowerCase() === "password");
    if (realPw.length >= 2) return true;

    // 其余（单个密码框、无明确新密码信号）一律视为登录 → 不弹。
    return false;
  }

  let genPopover = null;
  let genActiveField = null;
  let genLength = 16;
  let genCurrent = ""; // 生成的密码在多次聚焦间保持不变，只有「换一个」或改长度才更新
  function hideGenPopover() {
    if (genPopover) genPopover.style.display = "none";
  }

  function fillGeneratedPassword(pwField, value) {
    // 同表单/同根内所有可见密码框都填上（覆盖「确认密码」）。
    const scope = pwField.form || pwField.getRootNode();
    const pws = Array.from(scope.querySelectorAll("input")).filter((p) => isPasswordLike(p) && isVisible(p));
    for (const p of (pws.length ? pws : [pwField])) setNativeValue(p, value);
  }

  function showGenPopover(pwField) {
    if (!window.EPGen) return;
    if (!genPopover) {
      genPopover = document.createElement("div");
      genPopover.className = "ep-gen";
      genPopover.setAttribute("data-ep", "1");
      document.documentElement.appendChild(genPopover);
    }
    // 仅首次聚焦（或点「换一个」/改长度）才生成；之后聚焦保持同一个密码，方便逐字确认输入。
    if (!genCurrent) genCurrent = EPGen.generate({ length: genLength });

    const paint = () => {
      const st = EPGen.strength(genCurrent);
      genPopover.innerHTML = "";

      const head = document.createElement("div");
      head.className = "ep-gen-head";
      head.textContent = i18n("gen_head");

      const val = document.createElement("div");
      val.className = "ep-gen-val";
      val.textContent = genCurrent;

      const bar = document.createElement("div");
      bar.className = "ep-gen-bar";
      const fill = document.createElement("div");
      fill.className = "ep-gen-bar-fill ep-s" + st.score;
      fill.style.width = st.score * 25 + "%";
      bar.appendChild(fill);

      const meta = document.createElement("div");
      meta.className = "ep-gen-meta";
      meta.textContent = i18n("gen_meta", [i18n("strength_" + st.level), String(st.bits)]);
      const lenSel = document.createElement("select");
      lenSel.className = "ep-gen-len";
      [12, 16, 20, 24, 32].forEach((n) => {
        const op = document.createElement("option");
        op.value = n;
        op.textContent = n;
        if (n === genLength) op.selected = true;
        lenSel.appendChild(op);
      });
      lenSel.addEventListener("mousedown", (e) => e.stopPropagation());
      lenSel.addEventListener("change", () => {
        genLength = parseInt(lenSel.value, 10);
        genCurrent = EPGen.generate({ length: genLength });
        paint();
      });
      meta.appendChild(lenSel);

      const actions = document.createElement("div");
      actions.className = "ep-gen-actions";
      const useBtn = document.createElement("button");
      useBtn.className = "ep-btn ep-btn-primary";
      useBtn.textContent = i18n("gen_use");
      useBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        fillGeneratedPassword(pwField, genCurrent);
        hideGenPopover();
      });
      const reBtn = document.createElement("button");
      reBtn.className = "ep-btn";
      reBtn.textContent = i18n("gen_regen");
      reBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        genCurrent = EPGen.generate({ length: genLength });
        paint();
      });
      actions.appendChild(useBtn);
      actions.appendChild(reBtn);

      genPopover.appendChild(head);
      genPopover.appendChild(val);
      genPopover.appendChild(bar);
      genPopover.appendChild(meta);
      genPopover.appendChild(actions);
    };

    genActiveField = pwField;
    paint();
    const rect = pwField.getBoundingClientRect();
    genPopover.style.position = "fixed";
    genPopover.style.zIndex = "2147483647"; // 行内兜底，确保盖在宿主页面所有层之上
    genPopover.style.left = rect.left + "px";
    genPopover.style.top = rect.bottom + 2 + "px";
    genPopover.style.minWidth = Math.max(rect.width, 240) + "px";
    genPopover.style.display = "block";
  }

  let genOutsideBound = false;
  function attachGenerator() {
    // 只在「点到浮层和密码框之外」时收起浮层，避免点长度下拉时密码框失焦把浮层抖没了。
    if (!genOutsideBound) {
      genOutsideBound = true;
      document.addEventListener(
        "mousedown",
        (e) => {
          if (!genPopover || genPopover.style.display === "none") return;
          if (genPopover.contains(e.target) || e.target === genActiveField) return;
          hideGenPopover();
        },
        true
      );
    }
    for (const pw of getPasswordFields()) {
      if (pw.dataset.epGenBound) continue;
      pw.dataset.epGenBound = "1";
      pw.addEventListener("focus", () => {
        if (looksLikeNewPassword(pw, getPasswordFields())) showGenPopover(pw);
      });
    }
  }

  function bindSaveListeners() {
    for (const pair of getPairs()) {
      attach(pair.user);
      autofillFor(pair.user); // 落地自动填充本域账号

      // 直接挂到密码框下方的登录/提交按钮上（比全局关键词猜测更可靠）。
      const btn = submitButtonBelow(pair.pw);
      if (btn && !btn.dataset.epBtnBound) {
        btn.dataset.epBtnBound = "1";
        btn.addEventListener("click", () => setTimeout(noteSubmitAttempt, 60), true);
      }

      if (pair.pw.dataset.epSaveBound) continue;
      pair.pw.dataset.epSaveBound = "1";
      // 表单提交时尝试保存
      if (pair.pw.form && !pair.pw.form.dataset.epSubmitBound) {
        pair.pw.form.dataset.epSubmitBound = "1";
        pair.pw.form.addEventListener("submit", () => noteSubmitAttempt(), true);
      }
    }

    // 仅账号登录（手机/邮箱+验证码，无密码框）：也绑定账号提示下拉与提交检测。
    const pairUsers = new Set(getPairs().map((p) => p.user));
    for (const af of getAccountFields()) {
      if (pairUsers.has(af)) continue; // 已作为账号-密码配对处理
      attach(af);
      autofillFor(af); // 仅账号登录页也自动填账号
      if (af.dataset.epAcctBound) continue;
      af.dataset.epAcctBound = "1";
      const btn = submitButtonBelow(af);
      if (btn && !btn.dataset.epBtnBound) {
        btn.dataset.epBtnBound = "1";
        btn.addEventListener("click", () => setTimeout(noteSubmitAttempt, 60), true);
      }
      if (af.form && !af.form.dataset.epSubmitBound) {
        af.form.dataset.epSubmitBound = "1";
        af.form.addEventListener("submit", () => noteSubmitAttempt(), true);
      }
    }
  }

  // 提交关键词（去空格后匹配，兼容「登 录」这种带空格/字间距的写法）。
  const SUBMIT_RE = /登录|登陆|提交|确认|确定|保存|更改|修改|验证码|获取验证码|发送|短信|signin|login|submit|save|confirm|continue|继续|下一步|next|getcode|sendcode|dologin|loginbtn|btnlogin|submitbtn/i;

  // 判断点击的是否是登录/提交类控件（向上找最多 4 层）。
  // 兼容很多站点用 <a>/<div>/<span>（如 163/126 邮箱的 <a id="dologin">登 录</a>）当登录按钮、且无 <form>。
  function isSubmitLike(el) {
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      const tag = node.tagName;
      if (!tag || !node.getAttribute) continue;
      const type = (node.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT") {
        if (type === "submit" || type === "image") return true;
        if (type && type !== "button") return false; // text/email/password 等不是按钮
      }
      // 短文案才纳入（避免点到大容器时把整页文字误判）；id/class/aria 这类短标识始终参考。
      const txt = tag === "INPUT" ? "" : (node.textContent || "");
      const shortTxt = txt.trim().length <= 12 ? txt : "";
      const label = (
        shortTxt + " " + (node.getAttribute("aria-label") || "") + " " + (node.value || "") +
        " " + (node.id || "") + " " + (node.className || "") + " " + (node.name || "")
      ).replace(/\s+/g, "").toLowerCase();
      if (!label) continue;
      if (SUBMIT_RE.test(label)) {
        const role = node.getAttribute("role");
        if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SPAN" || tag === "DIV" || role === "button") {
          return true;
        }
      }
    }
    return false;
  }

  // 选出一个「账号与密码都填了」的配对用于保存。
  function filledPair() {
    return getPairs().find((p) => (p.pw.value || "") && (p.user.value || "").trim());
  }

  // 是否「可点击控件」：button / input 按钮 / a / role=button / id|class 含 btn|button|login|submit。
  function isClickable(el) {
    if (!el || !el.getAttribute || !isVisible(el)) return false;
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "BUTTON") return true;
    if (tag === "INPUT") return ["submit", "image", "button"].includes(type);
    if (tag === "A") return true;
    if (el.getAttribute("role") === "button") return true;
    return /btn|button|login|submit/.test(((el.id || "") + " " + (el.className || "")).toLowerCase());
  }

  // 排除「忘记密码 / 注册 / 找回 / 扫码 / 取消」等明显不是提交的控件。
  const NEG_RE = /忘记|找回|注册|帮助|切换|扫码|取消|help|forgot|register|sign\s*up|reset|cancel|qrcode/;
  function isNegativeControl(el) {
    const hay = ((el.textContent || "").slice(0, 24) + " " + (el.id || "") + " " + (el.className || "")).toLowerCase();
    return NEG_RE.test(hay);
  }

  // 检测到密码框后，找它「视觉上最近的下方/右侧可点击控件」（即登录/提交按钮），直接挂事件，
  // 比靠按钮文案猜更可靠——能覆盖图标按钮、自定义 <a>/<div> 按钮、无 <form> 的登录页。
  // 用几何就近（getBoundingClientRect）而非 DOM 顺序，兼容 flex/grid 下顺序错位。
  function submitButtonBelow(pwField) {
    const scope = pwField.form || pwField.getRootNode();
    const cands = Array.from(scope.querySelectorAll("*")).filter(
      (el) => isClickable(el) && !isNegativeControl(el)
    );
    if (!cands.length) return null;

    const pr = pwField.getBoundingClientRect();
    if (pr.width || pr.height) {
      const cx = pr.left + pr.width / 2;
      let best = null;
      let bestD = Infinity;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const ecy = r.top + r.height / 2;
        if (ecy < pr.top) continue; // 在密码框上方的排除
        const dx = r.left + r.width / 2 - cx;
        const dy = ecy - pr.bottom;
        const d = Math.hypot(dx, dy * 0.6); // 垂直权重低些，偏向正下方
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      }
      if (best) return best;
    }

    // 无几何信息时退回 DOM 顺序：密码框之后第一个可点击控件。
    const order = Array.from(scope.querySelectorAll("*"));
    const pwIdx = order.indexOf(pwField);
    for (let i = pwIdx + 1; i < order.length; i++) {
      if (cands.includes(order[i])) return order[i];
    }
    return null;
  }

  // 无 form 页面常按回车登录（如 163/126 邮箱）：在密码框按回车也触发保存判定。
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter") return;
      const t = e.target;
      if (t && t.tagName === "INPUT" && (isPasswordLike(t) || isAccountField(t))) {
        setTimeout(noteSubmitAttempt, 60);
      }
    },
    true
  );

  // SPA / 无 form 提交：点击提交类控件后尝试保存（form 自身的 submit 事件已单独绑定）。
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest && e.target.closest("[data-ep]")) return; // 忽略扩展自身的 UI
      if (!isSubmitLike(e.target)) return;
      setTimeout(noteSubmitAttempt, 50);
    },
    true
  );

  // 兜底：带着已填账号密码离开页面（整页跳转/关闭标签）时暂存，目标页再提示保存。
  function stashOnLeave() {
    const cap = captureLogin();
    if (cap && capSig(cap.domain, cap.username, cap.password) !== lastSaved) {
      send("STASH_PENDING", { domain: cap.domain, username: cap.username, password: cap.password, fullUrl: cap.fullUrl });
    }
  }
  window.addEventListener("pagehide", stashOnLeave, true);
  document.addEventListener(
    "visibilitychange",
    () => { if (document.visibilityState === "hidden") stashOnLeave(); },
    true
  );

  // 上一页提交后跳转到本页：若后台暂存了本域 pending，则在此提示保存。
  async function checkPendingSave() {
    const pend = await send("GET_PENDING", { domain: DOMAIN });
    if (pend && pend.ok && pend.username) {
      send("CLEAR_PENDING", { domain: DOMAIN });
      maybeSave(pend.username, pend.password, pend.domain || DOMAIN, pend.fullUrl); // 用捕获时的域名/URL 保存
    }
  }

  // ---------- 初始化 + 动态页面监听 ----------
  function scan() {
    bindSaveListeners();
    attachGenerator();
  }

  scan();
  checkPendingSave(); // 处理上一页提交后跳转过来的待保存凭据
  const observer = new MutationObserver(() => {
    clearTimeout(scan._t);
    scan._t = setTimeout(scan, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("scroll", () => activeUserField && dropdown && dropdown.style.display !== "none" && positionDropdown(activeUserField), true);
  window.addEventListener("resize", () => activeUserField && dropdown && dropdown.style.display !== "none" && positionDropdown(activeUserField));
})();
