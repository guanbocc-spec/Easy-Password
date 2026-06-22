// 弹窗逻辑：主账户创建 / 解锁 / 自动锁定倒计时 + 凭据管理 + 加密备份。

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

const $ = (id) => document.getElementById(id);
const i18n = (key, subs) => chrome.i18n.getMessage(key, subs);
// ctx=panel：作为侧边栏运行（常驻、随标签页切换刷新）；否则是普通弹窗。
const IS_PANEL = new URLSearchParams(location.search).get("ctx") === "panel";
let allEntries = [];
let groupColors = {}; // {组名: "red"|"green"}
let overrides = {}; // {host:端口: "red"|"green"} 站点环境标记覆盖
let currentHost = ""; // 侧边栏当前活跃标签的 host:端口
let timerInterval = null;

// 把 data-i18n / data-i18n-ph / data-i18n-title 占位填充为当前语言文案。
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = i18n(el.getAttribute("data-i18n"));
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    const m = i18n(el.getAttribute("data-i18n-ph"));
    if (m) el.setAttribute("placeholder", m);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = i18n(el.getAttribute("data-i18n-title"));
    if (m) el.setAttribute("title", m);
  });
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1900);
}

// ---------- 网站访问授权（optional_host_permissions）----------

async function hostGranted() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}

// 顶部授权条仅在「主界面且未授权」时出现（创建账户后的引导由 viewPerm 负责）。
async function refreshPermBar() {
  const granted = await hostGranted();
  $("permBar").hidden = granted || $("viewMain").hidden;
}

// 申请网站访问权限（须由用户手势调用）。返回是否授权成功，UI 由调用方刷新。
async function requestHostAccess() {
  try {
    const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
    if (ok) {
      toast(i18n("perm_granted"));
      send("SYNC_CS"); // 后台注册内容脚本并注入当前页
    }
    return ok;
  } catch {
    return false;
  }
}

async function getActiveDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return new URL(tab.url).host; // 含端口，兼容内网 IP:端口
  } catch {
    /* ignore */
  }
  return "";
}

// ---------- 视图切换 ----------

function showView(name) {
  $("viewSetup").hidden = name !== "setup";
  $("viewUnlock").hidden = name !== "unlock";
  $("viewMain").hidden = name !== "main";
  $("viewChange").hidden = name !== "change";
  $("viewPerm").hidden = name !== "perm";
  const unlocked = name === "main";
  $("lockBtn").hidden = !unlocked;
  $("lockTimer").hidden = !unlocked;
  $("pinBtn").hidden = !unlocked || IS_PANEL; // 📌 仅普通弹窗里出现（侧边栏自身无需再固定）
  $("tag").hidden = unlocked;
  if (name !== "main") $("permBar").hidden = true; // 非主界面不显示顶部授权条
  $("panelSite").hidden = !(unlocked && IS_PANEL && currentHost);
}

function startTimer(expiresAt) {
  clearInterval(timerInterval);
  let exp = expiresAt;
  let n = 0;
  const tick = async () => {
    // 每 3 秒向后台同步一次（反映内容脚本活动带来的滑动续期 / 提前锁定）。
    if (n++ % 3 === 0) {
      const st = await send("GET_AUTH_STATE");
      if (!st || !st.unlocked) {
        clearInterval(timerInterval);
        refresh();
        return;
      }
      exp = st.expiresAt;
    }
    const left = exp - Date.now();
    if (left <= 0) {
      clearInterval(timerInterval);
      refresh();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $("lockTimer").textContent = i18n("timer_lock", [`${m}:${String(s).padStart(2, "0")}`]);
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

async function refresh() {
  const st = await send("GET_AUTH_STATE");
  if (!st || !st.ok) {
    showView("setup");
    return;
  }
  if (!st.configured) {
    showView("setup");
  } else if (!st.unlocked) {
    clearInterval(timerInterval);
    showView("unlock");
    if (st.account) $("unlockAccount").value = st.account;
    $("unlockPass").focus();
  } else {
    showView("main");
    $("lockMinutes").value = String(st.settings ? st.settings.unlockMinutes : 30);
    $("sliding").checked = st.settings ? st.settings.sliding : true;
    $("kdfInfo").textContent = i18n(st.kdf === "argon2id" ? "kdf_argon" : "kdf_pbkdf2");
    startTimer(st.expiresAt);
    await loadList();
    refreshPermBar(); // 主界面：未授权时显示顶部授权条
    // 每周备份提醒：本周未备份且库里有内容时弹出（导出成功才会消除）。
    if (allEntries.length > 0 && isBackupDue(st.settings)) $("backupModal").hidden = false;
  }
}

async function handleSettingsChange() {
  const unlockMinutes = parseInt($("lockMinutes").value, 10);
  const sliding = $("sliding").checked;
  const res = await send("SET_SETTINGS", { unlockMinutes, sliding });
  if (res && res.ok) {
    toast(i18n("toast_settings_saved"));
    if (res.expiresAt) startTimer(res.expiresAt);
  }
}

// ---------- 主账户 / 解锁 ----------

async function handleSetup() {
  const account = $("setupAccount").value.trim();
  const p1 = $("setupPass").value;
  const p2 = $("setupPass2").value;
  if (!account || !p1) return toast(i18n("err_fill_account_pass"));
  if (p1.length < 6) return toast(i18n("err_pw_min6"));
  if (p1 !== p2) return toast(i18n("err_pw_mismatch"));
  const res = await send("SETUP_ACCOUNT", { account, password: p1 });
  if (res && res.ok) {
    toast(i18n("toast_account_created"));
    // 创建主账户后主动引导授权网站访问（未授权则进引导页，由用户点击触发系统请求）。
    if (await hostGranted()) refresh();
    else showView("perm");
  } else {
    toast(res?.error || i18n("err_create_fail"));
  }
}

async function handleUnlock() {
  const account = $("unlockAccount").value.trim();
  const password = $("unlockPass").value;
  const res = await send("UNLOCK", { account, password });
  if (res && res.ok) {
    $("unlockPass").value = "";
    refresh();
  } else {
    toast(res?.error || i18n("err_unlock_fail"));
  }
}

async function handleLock() {
  await send("LOCK");
  clearInterval(timerInterval);
  refresh();
}

function openChangePassword() {
  $("curPass").value = "";
  $("newPass").value = "";
  $("newPass2").value = "";
  showView("change");
  $("curPass").focus();
}

async function handleChangeSubmit() {
  const oldPassword = $("curPass").value;
  const newPassword = $("newPass").value;
  const confirm = $("newPass2").value;
  if (!oldPassword || !newPassword) return toast(i18n("err_fill_cur_new"));
  if (newPassword.length < 6) return toast(i18n("err_new_pw_min6"));
  if (newPassword !== confirm) return toast(i18n("err_new_pw_mismatch"));
  const res = await send("CHANGE_PASSWORD", { oldPassword, newPassword });
  if (res && res.ok) {
    toast(i18n("toast_pw_changed"));
    refresh(); // 回到主界面
  } else {
    toast(res?.error || i18n("err_change_fail"));
  }
}

// ---------- 凭据列表 ----------

// 默认折叠：展开的分组记在 expandedGroups（localStorage 持久化）。
const expandedGroups = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem("ep_expanded") || "[]");
    } catch {
      return [];
    }
  })()
);
function saveExpanded() {
  try {
    localStorage.setItem("ep_expanded", JSON.stringify([...expandedGroups]));
  } catch {
    /* ignore */
  }
}

async function loadList() {
  const [res, gr, ov] = await Promise.all([send("LIST_ALL"), send("GET_GROUPS"), send("GET_OVERRIDES")]);
  allEntries = res && res.ok && Array.isArray(res.entries) ? res.entries : [];
  groupColors = gr && gr.ok ? gr.groups || {} : {};
  overrides = ov && ov.ok ? ov.overrides || {} : {};
  updateGroupDatalist();
  renderOverrides();
  renderList();
}

// 第 3 条：渲染已有站点覆盖（host → 颜色 + 移除）。
function renderOverrides() {
  const box = $("overrideList");
  if (!box) return;
  box.innerHTML = "";
  for (const host of Object.keys(overrides).sort()) {
    const chip = document.createElement("span");
    chip.className = "override-chip";
    const dot = document.createElement("span");
    dot.className = "color-dot c-" + overrides[host] + " active";
    const name = document.createElement("span");
    name.textContent = host;
    const rm = document.createElement("button");
    rm.className = "override-rm";
    rm.textContent = "✕";
    rm.title = i18n("title_remove_override");
    rm.addEventListener("click", () => setOverride(host, "none"));
    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(rm);
    box.appendChild(chip);
  }
}

// 设置/移除站点覆盖；移除时回落到该站点所属分组的颜色。
async function setOverride(host, color) {
  host = (host || "").trim().toLowerCase();
  if (!host) return;
  await send("ARM_ENV", { domain: host, color, override: true });
  if (color === "none") {
    // 回落分组色：找一条该 host 的条目，按其分组色重新 arm。
    const e = allEntries.find((x) => (x.domain || "").toLowerCase() === host && groupColors[(x.group || "").trim()]);
    if (e) await send("ARM_ENV", { domain: host, color: groupColors[e.group.trim()], override: false });
  }
  toast(i18n("toast_override_saved"));
  const ov = await send("GET_OVERRIDES");
  overrides = ov && ov.ok ? ov.overrides || {} : {};
  renderOverrides();
}

// 第 4 条：分组下拉候选 = 已有分组（条目里的 + 注册表里的）。
function updateGroupDatalist() {
  const names = new Set(Object.keys(groupColors));
  for (const e of allEntries) if ((e.group || "").trim()) names.add(e.group.trim());
  const dl = $("groupList");
  if (!dl) return;
  dl.innerHTML = "";
  for (const n of [...names].sort()) {
    const o = document.createElement("option");
    o.value = n;
    dl.appendChild(o);
  }
}

function renderList() {
  const q = ($("search").value || "").toLowerCase();
  const list = $("list");
  list.innerHTML = "";
  let entries = allEntries.filter(
    (e) =>
      e.username.toLowerCase().includes(q) ||
      e.domain.toLowerCase().includes(q) ||
      (e.note || "").toLowerCase().includes(q) ||
      (e.group || "").toLowerCase().includes(q)
  );
  // 侧边栏：当前站点的条目排到最前，密码送到手边。
  if (currentHost) {
    entries = entries.slice().sort((a, b) => (b.domain === currentHost) - (a.domain === currentHost));
  }
  $("empty").style.display = entries.length ? "none" : "block";

  const ungrouped = entries.filter((e) => !(e.group || "").trim());
  const grouped = {};
  for (const e of entries) {
    const g = (e.group || "").trim();
    if (g) (grouped[g] = grouped[g] || []).push(e);
  }

  for (const e of ungrouped) list.appendChild(buildEntryRow(e));
  for (const g of Object.keys(grouped).sort()) {
    // 搜索时强制展开命中组，便于看到结果。
    const expanded = expandedGroups.has(g) || !!q;
    list.appendChild(buildGroupHeader(g, grouped[g], expanded));
    if (expanded) for (const e of grouped[g]) list.appendChild(buildEntryRow(e));
  }
}

function buildEntryRow(e) {
  const row = document.createElement("div");
  row.className = "entry";
  if (currentHost && e.domain === currentHost) row.classList.add("entry-current");

  const main = document.createElement("div");
  main.className = "entry-main";
  const user = document.createElement("div");
  user.className = "entry-user";
  user.textContent = e.username;
  user.title = i18n("title_copy_user");
  user.addEventListener("click", () => copyText(e.username, "toast_user_copied"));
  const domain = document.createElement("div");
  domain.className = "entry-domain";
  domain.textContent = e.domain;
  const pass = document.createElement("div");
  pass.className = "entry-pass";
  main.appendChild(user);
  main.appendChild(domain);
  if (e.note) {
    const note = document.createElement("div");
    note.className = "entry-note";
    note.textContent = e.note;
    main.appendChild(note);
  }
  main.appendChild(pass);

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  if (e.fullUrl) {
    const launch = document.createElement("button");
    launch.className = "mini";
    launch.textContent = "🚀";
    launch.title = i18n("title_launch");
    launch.addEventListener("click", () => launchUrl(e.fullUrl, e, true));
    actions.appendChild(launch);
  }

  if (e.hasPassword) {
    const showBtn = document.createElement("button");
    showBtn.className = "mini";
    showBtn.textContent = i18n("btn_show");
    showBtn.addEventListener("click", async () => {
      if (pass.classList.contains("show")) {
        pass.classList.remove("show");
        showBtn.textContent = i18n("btn_show");
        return;
      }
      const res = await send("REVEAL_PASSWORD", { id: e.id });
      if (res && res.ok) {
        pass.textContent = res.password;
        pass.classList.add("show");
        showBtn.textContent = i18n("btn_hide");
      } else {
        toast(res?.error || i18n("err_decrypt_fail"));
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "mini";
    copyBtn.textContent = i18n("btn_copy");
    copyBtn.addEventListener("click", async () => {
      const res = await send("REVEAL_PASSWORD", { id: e.id });
      if (res && res.ok) copyText(res.password, "toast_copied");
      else toast(res?.error || i18n("err_decrypt_fail"));
    });

    actions.appendChild(showBtn);
    actions.appendChild(copyBtn);
  } else {
    const tag = document.createElement("span");
    tag.className = "entry-tag";
    tag.textContent = i18n("account_only");
    actions.appendChild(tag);
  }

  const noteBtn = document.createElement("button");
  noteBtn.className = "mini";
  noteBtn.textContent = "📝";
  noteBtn.title = i18n("title_edit_note");
  noteBtn.addEventListener("click", () => openNoteEditor(e.id, e.note || "", e.group || ""));

  const delBtn = document.createElement("button");
  delBtn.className = "mini danger";
  delBtn.textContent = i18n("btn_delete");
  delBtn.addEventListener("click", async () => {
    await send("DELETE_ENTRY", { id: e.id });
    toast(i18n("toast_deleted"));
    loadList();
  });

  actions.appendChild(noteBtn);
  actions.appendChild(delBtn);
  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

// 分组头：折叠箭头 + 组名(条数) + 颜色三点(无/红/绿) + 全部启动🚀。默认折叠。
function buildGroupHeader(name, members, expanded) {
  const head = document.createElement("div");
  head.className = "group-head";
  const color = groupColors[name] || "none";

  // 点击「箭头 + 组名」区域切换折叠（颜色点/启动按钮各自 stopPropagation）。
  const toggle = document.createElement("span");
  toggle.className = "group-toggle";
  const caret = document.createElement("span");
  caret.className = "group-caret";
  caret.textContent = expanded ? "▾" : "▸";
  const label = document.createElement("span");
  label.className = "group-name g-" + color;
  label.textContent = name + "（" + members.length + "）";
  toggle.appendChild(caret);
  toggle.appendChild(label);
  toggle.addEventListener("click", () => {
    if (expandedGroups.has(name)) expandedGroups.delete(name);
    else expandedGroups.add(name);
    saveExpanded();
    renderList();
  });

  const dots = document.createElement("span");
  dots.className = "group-colors";
  for (const c of ["none", "red", "green"]) {
    const dot = document.createElement("button");
    dot.className = "color-dot c-" + c + (color === c ? " active" : "");
    dot.title = i18n("title_color_" + c);
    dot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      changeGroupColor(name, c, members);
    });
    dots.appendChild(dot);
  }

  head.appendChild(toggle);
  head.appendChild(dots);
  if (members.some((m) => m.fullUrl)) {
    const launchAll = document.createElement("button");
    launchAll.className = "mini group-launch";
    launchAll.textContent = i18n("group_launch_all");
    launchAll.addEventListener("click", (ev) => {
      ev.stopPropagation();
      launchGroup(members);
    });
    head.appendChild(launchAll);
  }
  return head;
}

async function copyText(text, okKey) {
  try {
    await navigator.clipboard.writeText(text);
    toast(i18n(okKey));
  } catch {
    toast(i18n("err_copy_fail"));
  }
}

// 模块四：若该条目属于彩色分组，标记其域名为对应颜色（注入呼吸边框）。
function armIfColored(e) {
  const color = e && e.group ? groupColors[(e.group || "").trim()] : null;
  if (color && color !== "none") send("ARM_ENV", { domain: e.domain, color });
}

// 模块一：新标签直达 + 落地自动填充（IP 匹配机制已存在）。
async function launchUrl(url, e, closeAfter) {
  if (!url) {
    toast(i18n("err_no_url"));
    return;
  }
  armIfColored(e);
  try {
    await chrome.tabs.create({ url });
    if (closeAfter && !IS_PANEL) window.close();
  } catch {
    toast(i18n("err_no_url"));
  }
}

// 模块三：组内一键并发打卡（后台静默开，>8 触发确认气囊）。
async function launchGroup(members) {
  const targets = members.filter((m) => m.fullUrl);
  if (!targets.length) {
    toast(i18n("err_no_url"));
    return;
  }
  if (targets.length > 8 && !window.confirm(i18n("confirm_launch_many", [String(targets.length)]))) return;
  for (const m of targets) {
    armIfColored(m);
    try {
      await chrome.tabs.create({ url: m.fullUrl, active: false });
    } catch {
      /* 个别 URL 失败不阻断其余 */
    }
  }
  toast(i18n("toast_launched", [String(targets.length)]));
}

// 模块四：设置分组颜色，并对组内所有域名 arm/disarm 环境警告。
async function changeGroupColor(name, color, members) {
  const res = await send("SET_GROUP_COLOR", { group: name, color });
  if (res && res.ok) groupColors = res.groups || {};
  for (const m of members) send("ARM_ENV", { domain: m.domain, color });
  renderList();
}

async function handleAdd() {
  let domain = ($("addDomain").value || "").trim();
  if (!domain) domain = await getActiveDomain();
  const username = ($("addUser").value || "").trim();
  const password = $("addPass").value || "";
  const note = ($("addNote").value || "").trim();
  const group = ($("addGroup").value || "").trim();
  const fullUrl = ($("addFullUrl").value || "").trim();
  if (!domain || !username) return toast(i18n("err_fill_domain_user")); // 密码可留空＝仅记账号
  const res = await send("SAVE_CREDENTIAL", { domain, username, password, note, group, fullUrl });
  if (res && res.ok) {
    toast(res.savedPassword ? (res.updated ? i18n("toast_updated") : i18n("toast_saved")) : i18n("toast_account_remembered"));
    $("addUser").value = "";
    $("addPass").value = "";
    $("addNote").value = "";
    $("addGroup").value = "";
    $("addFullUrl").value = "";
    $("addPass").type = "password";
    $("pwStrength").hidden = true; // 第 2 条：保存后清空强度条
    renderStrength();
    loadList();
  } else {
    toast(res?.error || i18n("err_save_fail"));
  }
}

// 一键清除并禁用浏览器自带的「记住密码」（用可选权限，点击时申请）。
async function handleDisableBrowserPM() {
  if (!window.confirm(i18n("confirm_clear_browser"))) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ["browsingData", "privacy"] });
  } catch {
    granted = false;
  }
  if (!granted) {
    toast(i18n("err_perm_denied"));
    return;
  }
  try {
    await chrome.browsingData.remove({}, { passwords: true }); // 清空浏览器保存的密码
    // 关闭「提示保存密码」开关
    const ps = chrome.privacy && chrome.privacy.services && chrome.privacy.services.passwordSavingEnabled;
    if (ps) await new Promise((res) => ps.set({ value: false }, () => res()));
    toast(i18n("toast_browser_cleared"));
  } catch {
    toast(i18n("err_perm_denied"));
  }
}

// ---------- 备注编辑 ----------

let pendingNoteId = null;
function openNoteEditor(id, note, group) {
  pendingNoteId = id;
  $("noteInput").value = note || "";
  $("noteGroupInput").value = group || "";
  $("noteModal").hidden = false;
  $("noteInput").focus();
}
async function saveNote() {
  if (!pendingNoteId) return;
  const res = await send("UPDATE_ENTRY", {
    id: pendingNoteId,
    note: $("noteInput").value,
    group: $("noteGroupInput").value,
  });
  if (res && res.ok) {
    $("noteModal").hidden = true;
    pendingNoteId = null;
    loadList();
  } else {
    toast(res?.error || i18n("err_save_fail"));
  }
}

// ---------- 强密码生成 / 强度 ----------

function renderStrength() {
  const pw = $("addPass").value;
  const box = $("pwStrength");
  const fill = $("pwBarFill");
  if (!pw || !window.EPGen) {
    // 清空：彻底复位，避免保存后残留上一次的强度。
    box.hidden = true;
    fill.style.width = "0%";
    fill.className = "pw-bar-fill";
    $("pwLabel").textContent = "";
    return;
  }
  const st = EPGen.strength(pw);
  box.hidden = false;
  fill.className = "pw-bar-fill s" + st.score;
  // 用「熵 bit」做连续宽度（而非 4 档 25%），增减都能实时反映、不再「只会增」。
  fill.style.width = Math.max(4, Math.min(100, Math.round((st.bits / 80) * 100))) + "%";
  $("pwLabel").textContent = `${i18n("strength_" + st.level)} · ${st.bits} bit`;
}

function handleGenerate() {
  if (!window.EPGen) return;
  const pw = EPGen.generate({ length: 16 });
  const input = $("addPass");
  input.value = pw;
  input.type = "text"; // 生成后默认显示，方便确认
  renderStrength();
}

// ---------- 加密备份 ----------

function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 返回是否成功导出（成功才记录本周已备份，用于消除提醒——即“检查备份过程”）。
async function handleExport() {
  const res = await send("EXPORT_BACKUP");
  if (!res || !res.ok) {
    toast(res?.error || i18n("err_export_fail"));
    return false;
  }
  try {
    download("easy-password-backup.json", JSON.stringify(res.backup, null, 2));
  } catch {
    toast(i18n("err_export_fail"));
    return false;
  }
  await send("SET_SETTINGS", { lastBackupAt: Date.now() });
  toast(i18n("toast_exported"));
  return true;
}

// 本周一 00:00 的时间戳。
function thisWeekMondayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日,1=周一
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.getTime();
}

// 是否“本周尚未备份”（每到周一就到期，直到完成本周备份）。
function isBackupDue(settings) {
  const last = settings && settings.lastBackupAt;
  return !last || last < thisWeekMondayStart();
}

let pendingImportBackup = null;

function handleImport(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let backup;
    try {
      backup = JSON.parse(reader.result);
    } catch {
      toast(i18n("err_file_format"));
      return;
    }
    // 加密备份（v3）：弹出主密码输入框；旧版明文备份直接导入。
    if (backup && backup.version >= 3) {
      pendingImportBackup = backup;
      $("importPass").value = "";
      $("importModal").hidden = false;
      $("importPass").focus();
      return;
    }
    doImport(backup, undefined);
  };
  reader.readAsText(file);
}

async function doImport(backup, password) {
  const res = await send("IMPORT_BACKUP", { backup, password });
  if (res && res.ok) {
    $("importModal").hidden = true;
    pendingImportBackup = null;
    toast(i18n("toast_imported"));
    refresh();
  } else {
    // 密码错误时保留弹框，便于重试。
    toast(res?.error || i18n("err_import_fail"));
  }
}

// ---------- 初始化 ----------

function init() {
  applyI18n();
  // 顶部授权条（主界面、未授权时）
  $("permBtn").addEventListener("click", async () => {
    await requestHostAccess();
    refreshPermBar();
  });
  // 创建账户后的授权引导页
  $("permGrantBtn").addEventListener("click", async () => {
    await requestHostAccess();
    refresh();
  });
  $("permSkipBtn").addEventListener("click", () => refresh());

  // 每周备份提醒：确认即导出，成功才关闭；稍后则本次关闭（下次打开仍提醒）。
  $("backupNowBtn").addEventListener("click", async () => {
    if (await handleExport()) $("backupModal").hidden = true;
  });
  $("backupLaterBtn").addEventListener("click", () => {
    $("backupModal").hidden = true;
  });

  // 导入加密备份的主密码弹框
  $("importConfirmBtn").addEventListener("click", () => {
    if (pendingImportBackup) doImport(pendingImportBackup, $("importPass").value);
  });
  $("importCancelBtn").addEventListener("click", () => {
    $("importModal").hidden = true;
    pendingImportBackup = null;
  });
  $("importPass").addEventListener("keydown", (e) => e.key === "Enter" && $("importConfirmBtn").click());

  // 编辑备注弹框
  $("noteSaveBtn").addEventListener("click", saveNote);
  $("noteCancelBtn").addEventListener("click", () => {
    $("noteModal").hidden = true;
    pendingNoteId = null;
  });
  $("noteInput").addEventListener("keydown", (e) => e.key === "Enter" && saveNote());

  $("setupBtn").addEventListener("click", handleSetup);
  $("setupPass2").addEventListener("keydown", (e) => e.key === "Enter" && handleSetup());
  $("unlockBtn").addEventListener("click", handleUnlock);
  $("unlockPass").addEventListener("keydown", (e) => e.key === "Enter" && handleUnlock());
  $("lockBtn").addEventListener("click", handleLock);
  $("pwdBtn").addEventListener("click", openChangePassword);
  $("changeBtn").addEventListener("click", handleChangeSubmit);
  $("changeCancelBtn").addEventListener("click", () => refresh());
  $("newPass2").addEventListener("keydown", (e) => e.key === "Enter" && handleChangeSubmit());
  $("lockMinutes").addEventListener("change", handleSettingsChange);
  $("sliding").addEventListener("change", handleSettingsChange);

  getActiveDomain().then((d) => {
    if (d) $("addDomain").value = d;
  });
  $("addBtn").addEventListener("click", handleAdd);
  $("addPass").addEventListener("keydown", (e) => e.key === "Enter" && handleAdd());
  $("addPass").addEventListener("input", renderStrength);
  $("genPass").addEventListener("click", handleGenerate);
  $("togglePass").addEventListener("click", () => {
    const p = $("addPass");
    p.type = p.type === "password" ? "text" : "password";
  });
  $("search").addEventListener("input", renderList);
  $("exportBtn").addEventListener("click", handleExport);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) handleImport(e.target.files[0]);
  });

  // 第 2 条：手动新增区默认隐藏，点击展开/收起。
  $("addToggle").addEventListener("click", () => {
    $("addSection").hidden = !$("addSection").hidden;
  });

  // 第 3 条：站点环境标记覆盖 —— 三色点对当前输入的 host 生效。
  document.querySelectorAll("#viewMain .override-input .color-dot").forEach((dot) => {
    dot.addEventListener("click", () => setOverride($("overrideHost").value, dot.dataset.color));
  });

  // 一键清除并禁用浏览器自带密码
  $("clearBrowserPM").addEventListener("click", handleDisableBrowserPM);

  // 模块二：📌 打开侧边栏常驻
  $("pinBtn").addEventListener("click", openSidePanel);
  if (IS_PANEL) setupPanel();

  // 第 1 条：库变化时实时刷新（弹窗新增 ↔ 侧边栏同步）。
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if ((ch.ep_entries || ch.ep_groups || ch.ep_overrides) && !$("viewMain").hidden) loadList();
    });
  } catch {
    /* ignore */
  }

  refresh();
}

// 模块二：把当前界面平移固定到侧边栏。
async function openSidePanel() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close(); // 关闭弹窗，留下侧边栏
  } catch {
    /* 不支持 sidePanel 的旧版浏览器 */
  }
}

// 侧边栏常驻：随标签切换/导航实时刷新当前站点与列表。
function setupPanel() {
  document.body.classList.add("is-panel");
  chrome.tabs.onActivated.addListener(updateCurrentSite);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.url || info.status === "complete") updateCurrentSite();
  });
  updateCurrentSite();
}

async function updateCurrentSite() {
  currentHost = await getActiveDomain();
  const ps = $("panelSite");
  if (currentHost) {
    ps.textContent = i18n("panel_current") + "：" + currentHost;
    ps.title = i18n("title_copy_site");
    ps.onclick = () => copyText(currentHost, "toast_site_copied"); // 第 5 条：点击复制
    if (!$("viewMain").hidden) ps.hidden = false;
    // 新增表单的域名随 tab 切换更新（未在手动编辑该框时才覆盖）。
    if (document.activeElement !== $("addDomain")) $("addDomain").value = currentHost;
  } else {
    ps.hidden = true;
  }
  if (!$("viewMain").hidden) renderList();
}

document.addEventListener("DOMContentLoaded", init);
