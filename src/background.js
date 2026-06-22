// 后台 Service Worker：主账户/解锁体系 + 密钥管理 + 加解密 + 存储 + 消息路由。
//
// 安全模型（v2）：
//  - 主密码经 KDF（默认 Argon2id，旧数据兼容 PBKDF2）派生出 AES-GCM 密钥；
//    用它把 RSA 私钥、域名 HMAC 密钥加密后存盘（落盘的只有密文）。
//  - 解锁时解出私钥与域名密钥，仅放入 chrome.storage.session（内存，不落盘），
//    带可配置过期时间（默认 30 分钟），活动时可滑动续期。
//  - 域名以 HMAC token 存储（不可逆）+ RSA 密文（供展示）；明文域名不落盘。
//  - 所有「凭据」操作都要求会话处于解锁状态。

import {
  generateKeyPair,
  importPublicKey,
  importPrivateKey,
  encryptText,
  decryptText,
  randomB64,
  deriveAesKey,
  importAesKeyRaw,
  importHmacKey,
  hmacHex,
  aesEncrypt,
  aesDecrypt,
} from "./crypto.js";
import { argon2idBytes } from "./argon2.js";

const t = (key, subs) => chrome.i18n.getMessage(key, subs);

const STORAGE = {
  AUTH: "ep_auth",
  ENTRIES: "ep_entries",
  SETTINGS: "ep_settings",
  GROUPS: "ep_groups", // {组名: "none"|"red"|"green"}（明文标签，非密钥）
  ENV: "ep_env", // {host:端口: "red"|"green"}（最终生效色，供环境警告内容脚本读取）
  OVERRIDES: "ep_overrides", // {host:端口: "red"|"green"}（按站点覆盖，优先级高于分组）
};
const SESSION = "ep_session";
const PENDING = "ep_pending"; // 跨导航待保存凭据（内存、短时效）
const PENDING_TTL = 120000;
const VERIFIER_PREFIX = "ep-verifier:";

// KDF 默认：Argon2id（19 MiB / 2 轮 / 并行 1）。旧数据若为 pbkdf2 则解锁时自动升级。
const KDF_DEFAULT = { type: "argon2id", t: 2, m: 19456, p: 1 };
const PBKDF2_FALLBACK_ITER = 600000;

const SETTINGS_DEFAULT = { unlockMinutes: 30, sliding: true };

// ---------- 基础存储 ----------

async function getAuth() {
  const d = await chrome.storage.local.get(STORAGE.AUTH);
  return d[STORAGE.AUTH] || null;
}
async function setAuth(auth) {
  await chrome.storage.local.set({ [STORAGE.AUTH]: auth });
}
async function getEntries() {
  const d = await chrome.storage.local.get(STORAGE.ENTRIES);
  return d[STORAGE.ENTRIES] || [];
}
async function setEntries(entries) {
  await chrome.storage.local.set({ [STORAGE.ENTRIES]: entries });
}
async function getSettings() {
  const d = await chrome.storage.local.get(STORAGE.SETTINGS);
  return { ...SETTINGS_DEFAULT, ...(d[STORAGE.SETTINGS] || {}) };
}

// 会话存于内存型 storage.session，带过期自动失效。
async function getSession() {
  const d = await chrome.storage.session.get(SESSION);
  const s = d[SESSION];
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    await chrome.storage.session.remove(SESSION);
    return null;
  }
  return s;
}
async function writeSession(sess) {
  await chrome.storage.session.set({ [SESSION]: sess });
  try {
    await chrome.alarms.create("ep-lock", { when: sess.expiresAt });
  } catch {
    /* 忽略，依赖惰性过期 */
  }
}
// mk = 主密钥的原始字节（数组），仅存内存，用于一键加密导出备份（不必再输主密码）。
async function openSession(privateJwk, domainKey, mk) {
  const { unlockMinutes } = await getSettings();
  const expiresAt = Date.now() + unlockMinutes * 60000;
  await writeSession({ privateJwk, domainKey, mk, expiresAt });
  return expiresAt;
}
async function clearSession() {
  await chrome.storage.session.remove(SESSION);
}

// 站点标识用 host（含端口），兼容内网「IP:端口」（无域名时靠端口区分应用）。
function normalizeDomain(input) {
  if (!input) return "";
  try {
    const url = input.includes("://") ? new URL(input) : new URL("https://" + input);
    return url.host.toLowerCase();
  } catch {
    return String(input).trim().toLowerCase();
  }
}

// ---------- KDF 派生 ----------

async function deriveMasterKey(password, salt, kdf) {
  if (kdf && kdf.type === "argon2id") {
    const bytes = await argon2idBytes(password, salt, kdf);
    return importAesKeyRaw(bytes);
  }
  // 兼容旧 PBKDF2 数据
  return deriveAesKey(password, salt, (kdf && kdf.iterations) || PBKDF2_FALLBACK_ITER);
}

// 派生主密钥并返回原始字节（仅 Argon2id 路径有字节，用于会话内一键加密导出备份）。
async function deriveMasterKeyBytes(password, salt, kdf) {
  if (kdf && kdf.type === "argon2id") {
    const bytes = await argon2idBytes(password, salt, kdf);
    return { key: await importAesKeyRaw(bytes), mk: Array.from(bytes) };
  }
  return { key: await deriveMasterKey(password, salt, kdf), mk: null };
}

// 用主密钥把私钥/域名密钥/校验串打包成 auth 结构。
async function buildAuth({ account, masterKey, salt, kdf, publicJwk, privateJwk, domainKey, createdAt }) {
  return {
    version: 2,
    account,
    salt,
    kdf,
    publicJwk,
    wrappedPrivate: await aesEncrypt(masterKey, JSON.stringify(privateJwk)),
    wrappedDomainKey: await aesEncrypt(masterKey, domainKey),
    verifier: await aesEncrypt(masterKey, VERIFIER_PREFIX + account),
    createdAt: createdAt || Date.now(),
  };
}

// ---------- 主账户 / 解锁 ----------

async function setupAccount({ account, password }) {
  account = (account || "").trim();
  if (!account || !password) return { ok: false, error: t("err_fill_account_pass") };
  if (password.length < 6) return { ok: false, error: t("err_pw_min6") };
  if (await getAuth()) return { ok: false, error: t("err_account_exists") };

  const { publicJwk, privateJwk } = await generateKeyPair();
  const salt = randomB64(16);
  const domainKey = randomB64(32);
  const kdf = { ...KDF_DEFAULT };
  const { key: masterKey, mk } = await deriveMasterKeyBytes(password, salt, kdf);

  await setAuth(await buildAuth({ account, masterKey, salt, kdf, publicJwk, privateJwk, domainKey }));
  const expiresAt = await openSession(privateJwk, domainKey, mk);
  return { ok: true, expiresAt };
}

async function unlock({ account, password }) {
  const auth = await getAuth();
  if (!auth) return { ok: false, error: t("err_not_configured") };
  account = (account || "").trim();

  // 旧数据无 kdf 字段：按 PBKDF2 + 旧迭代数处理。
  const kdf = auth.kdf || { type: "pbkdf2", iterations: auth.iterations };
  let { key: masterKey, mk } = await deriveMasterKeyBytes(password, auth.salt, kdf);

  let verifierPlain;
  try {
    verifierPlain = await aesDecrypt(masterKey, auth.verifier.iv, auth.verifier.ct);
  } catch {
    return { ok: false, error: t("err_account_or_pw") };
  }
  if (verifierPlain !== VERIFIER_PREFIX + auth.account || account !== auth.account) {
    return { ok: false, error: t("err_account_or_pw") };
  }

  const privateJwk = JSON.parse(await aesDecrypt(masterKey, auth.wrappedPrivate.iv, auth.wrappedPrivate.ct));
  // 域名密钥：v2 才有；旧数据解锁时会在迁移中生成。
  let domainKey = auth.wrappedDomainKey
    ? await aesDecrypt(masterKey, auth.wrappedDomainKey.iv, auth.wrappedDomainKey.ct)
    : null;

  // 自动升级：KDF 非 Argon2id、或缺域名密钥、或条目仍是明文域名。
  const needUpgrade = kdf.type !== "argon2id" || !domainKey || (await hasPlaintextDomains());
  if (needUpgrade) {
    const up = await upgradeVault({ account: auth.account, password, publicJwk: auth.publicJwk, privateJwk, domainKey });
    domainKey = up.domainKey;
    mk = up.mk;
  }

  const expiresAt = await openSession(privateJwk, domainKey, mk);
  return { ok: true, expiresAt };
}

async function hasPlaintextDomains() {
  const entries = await getEntries();
  return entries.some((e) => e.domain && !e.domainToken);
}

// 升级到 v2：用 Argon2id 重新包裹密钥，给所有条目生成域名 token + 加密域名、去掉明文域名。
async function upgradeVault({ account, password, publicJwk, privateJwk, domainKey }) {
  const salt = randomB64(16);
  const kdf = { ...KDF_DEFAULT };
  const { key: masterKey, mk } = await deriveMasterKeyBytes(password, salt, kdf);
  if (!domainKey) domainKey = randomB64(32);

  await setAuth(await buildAuth({ account, masterKey, salt, kdf, publicJwk, privateJwk, domainKey }));

  const hmacKey = await importHmacKey(domainKey);
  const publicKey = await importPublicKey(publicJwk);
  const entries = await getEntries();
  let changed = false;
  for (const e of entries) {
    if (e.domain && !e.domainToken) {
      const dom = normalizeDomain(e.domain);
      e.domainToken = await hmacHex(hmacKey, dom);
      e.encDomain = await encryptText(publicKey, dom);
      delete e.domain;
      changed = true;
    }
  }
  if (changed) await setEntries(entries);
  return { domainKey, mk };
}

async function lock() {
  await clearSession();
  return { ok: true };
}

async function changePassword({ oldPassword, newPassword }) {
  const auth = await getAuth();
  if (!auth) return { ok: false, error: t("err_not_configured") };
  if (!newPassword || newPassword.length < 6) return { ok: false, error: t("err_new_pw_min6") };

  const kdf = auth.kdf || { type: "pbkdf2", iterations: auth.iterations };
  const oldKey = await deriveMasterKey(oldPassword, auth.salt, kdf);
  let privateJwk, domainKey;
  try {
    const v = await aesDecrypt(oldKey, auth.verifier.iv, auth.verifier.ct);
    if (v !== VERIFIER_PREFIX + auth.account) throw new Error("bad");
    privateJwk = JSON.parse(await aesDecrypt(oldKey, auth.wrappedPrivate.iv, auth.wrappedPrivate.ct));
    domainKey = auth.wrappedDomainKey
      ? await aesDecrypt(oldKey, auth.wrappedDomainKey.iv, auth.wrappedDomainKey.ct)
      : randomB64(32);
  } catch {
    return { ok: false, error: t("err_old_pw") };
  }

  const salt = randomB64(16);
  const newKdf = { ...KDF_DEFAULT };
  const { key: masterKey, mk } = await deriveMasterKeyBytes(newPassword, salt, newKdf);
  await setAuth(
    await buildAuth({
      account: auth.account,
      masterKey,
      salt,
      kdf: newKdf,
      publicJwk: auth.publicJwk,
      privateJwk,
      domainKey,
      createdAt: auth.createdAt,
    })
  );
  const expiresAt = await openSession(privateJwk, domainKey, mk);
  return { ok: true, expiresAt };
}

async function authState() {
  const auth = await getAuth();
  const session = await getSession();
  const settings = await getSettings();
  return {
    ok: true,
    configured: !!auth,
    unlocked: !!session,
    account: auth ? auth.account : null,
    expiresAt: session ? session.expiresAt : null,
    kdf: auth ? (auth.kdf ? auth.kdf.type : "pbkdf2") : null,
    settings,
  };
}

async function getSettingsMsg() {
  return { ok: true, settings: await getSettings() };
}

async function setSettingsMsg(payload) {
  const next = { ...(await getSettings()), ...payload };
  if (typeof next.unlockMinutes !== "number" || next.unlockMinutes < 1) next.unlockMinutes = SETTINGS_DEFAULT.unlockMinutes;
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: next });
  // 立即作用于当前会话：刷新过期时间。
  const sess = await getSession();
  if (sess) {
    sess.expiresAt = Date.now() + next.unlockMinutes * 60000;
    await writeSession(sess);
  }
  return { ok: true, settings: next, expiresAt: sess ? sess.expiresAt : null };
}

async function getPublicKey() {
  const auth = await getAuth();
  if (!auth) return null;
  return importPublicKey(auth.publicJwk);
}

// ---------- 凭据操作（均需解锁，ctx 提供 privateKey / hmacKey） ----------

async function entryDomainToken(e, hmacKey) {
  if (e.domainToken) return e.domainToken;
  if (e.domain) return hmacHex(hmacKey, normalizeDomain(e.domain)); // 理论上迁移后不会有
  return null;
}

async function saveCredential({ domain, username, password, note, fullUrl, group }, { privateKey, hmacKey }) {
  domain = normalizeDomain(domain);
  username = (username || "").trim();
  password = password || "";
  // 密码可选：很多站点用手机/邮箱+验证码登录，只记账号、没有密码。
  if (!domain || !username) return { ok: false, error: t("err_missing_fields") };
  const publicKey = await getPublicKey();
  const token = await hmacHex(hmacKey, domain);

  const encDomain = await encryptText(publicKey, domain);
  const encUsername = await encryptText(publicKey, username);
  const encPassword = password ? await encryptText(publicKey, password) : null;
  // 备注/完整 URL/分组都可能涉密，统一加密；undefined 表示「不改动该字段」。
  const encNote = note ? await encryptText(publicKey, note) : null;
  const encFullUrl = fullUrl ? await encryptText(publicKey, fullUrl) : null;
  const encGroup = group ? await encryptText(publicKey, group) : null;
  const entries = await getEntries();

  let matched = -1;
  for (let i = 0; i < entries.length; i++) {
    if ((await entryDomainToken(entries[i], hmacKey)) !== token) continue;
    try {
      if ((await decryptText(privateKey, entries[i].encUsername)) === username) {
        matched = i;
        break;
      }
    } catch {
      /* skip */
    }
  }

  const now = Date.now();
  if (matched >= 0) {
    // 只在带了对应值时才覆盖（undefined=不动；账号-only 保存不会清掉已存密码）。
    if (encPassword) entries[matched].encPassword = encPassword;
    if (note !== undefined) entries[matched].encNote = encNote;
    if (fullUrl !== undefined) entries[matched].encFullUrl = encFullUrl;
    if (group !== undefined) entries[matched].encGroup = encGroup;
    entries[matched].updatedAt = now;
  } else {
    entries.push({
      id: crypto.randomUUID(),
      domainToken: token,
      encDomain, encUsername, encPassword, encNote, encFullUrl, encGroup,
      createdAt: now, updatedAt: now,
    });
  }
  await setEntries(entries);
  return { ok: true, updated: matched >= 0, savedPassword: !!encPassword };
}

// 编辑条目的备注 / 完整URL / 分组（按 id；传哪个改哪个）。
async function updateEntry({ id, note, fullUrl, group }) {
  const entries = await getEntries();
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, error: t("err_entry_not_found") };
  const publicKey = await getPublicKey();
  if (note !== undefined) e.encNote = note && note.trim() ? await encryptText(publicKey, note) : null;
  if (fullUrl !== undefined) e.encFullUrl = fullUrl && fullUrl.trim() ? await encryptText(publicKey, fullUrl) : null;
  if (group !== undefined) e.encGroup = group && group.trim() ? await encryptText(publicKey, group) : null;
  e.updatedAt = Date.now();
  await setEntries(entries);
  return { ok: true };
}

async function getSuggestions({ domain, prefix }, { privateKey, hmacKey }) {
  const token = await hmacHex(hmacKey, normalizeDomain(domain));
  const entries = await getEntries();
  const p = (prefix || "").toLowerCase();
  const result = [];
  for (const e of entries) {
    if ((await entryDomainToken(e, hmacKey)) !== token) continue;
    let username;
    try {
      username = await decryptText(privateKey, e.encUsername);
    } catch {
      continue;
    }
    const lu = username.toLowerCase();
    let score = -1;
    if (p === "") score = 0;
    else if (lu.startsWith(p)) score = 2;
    else if (lu.includes(p)) score = 1;
    if (score >= 0) result.push({ id: e.id, username, score, updatedAt: e.updatedAt || 0 });
  }
  // 先按匹配度，再按最近使用（自动填充取第一个 = 最近用过的账号）。
  result.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.username.localeCompare(b.username));
  return result.map(({ id, username }) => ({ id, username }));
}

async function getPassword({ domain, username }, { privateKey, hmacKey }) {
  const token = await hmacHex(hmacKey, normalizeDomain(domain));
  const entries = await getEntries();
  for (const e of entries) {
    if ((await entryDomainToken(e, hmacKey)) !== token) continue;
    try {
      if ((await decryptText(privateKey, e.encUsername)) === username) {
        // 账号在但没存密码（仅账号）：exists=true、ok=false，调用方据此不回填也不报错。
        if (!e.encPassword) return { ok: false, exists: true };
        return { ok: true, exists: true, password: await decryptText(privateKey, e.encPassword) };
      }
    } catch {
      /* continue */
    }
  }
  return { ok: false, exists: false, error: t("err_no_match_account") };
}

async function listAll(_payload, { privateKey }) {
  const entries = await getEntries();
  const out = [];
  for (const e of entries) {
    let username = t("decrypt_placeholder");
    let domain = e.domain || "";
    let note = "";
    let fullUrl = "";
    let group = "";
    try {
      username = await decryptText(privateKey, e.encUsername);
      if (e.encDomain) domain = await decryptText(privateKey, e.encDomain);
      if (e.encNote) note = await decryptText(privateKey, e.encNote);
      if (e.encFullUrl) fullUrl = await decryptText(privateKey, e.encFullUrl);
      if (e.encGroup) group = await decryptText(privateKey, e.encGroup);
    } catch {
      /* ignore */
    }
    out.push({ id: e.id, domain, username, note, fullUrl, group, hasPassword: !!e.encPassword, updatedAt: e.updatedAt });
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain) || a.username.localeCompare(b.username));
  return { ok: true, entries: out };
}

async function revealPassword({ id }, { privateKey }) {
  const entries = await getEntries();
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, error: t("err_entry_not_found") };
  if (!e.encPassword) return { ok: false, error: t("err_no_password") };
  try {
    return { ok: true, password: await decryptText(privateKey, e.encPassword) };
  } catch {
    return { ok: false, error: t("err_decrypt_fail") };
  }
}

async function deleteEntry({ id }) {
  const entries = await getEntries();
  await setEntries(entries.filter((e) => e.id !== id));
  return { ok: true };
}

// 是否有已存条目：解锁时按域名精确判断；锁定时无法解析域名，仅返回总数（用于决定是否提示解锁）。
async function hasEntries({ domain }) {
  const session = await getSession();
  const entries = await getEntries();
  if (!session) return { ok: true, count: entries.length, exact: false };
  const hmacKey = await importHmacKey(session.domainKey);
  const token = await hmacHex(hmacKey, normalizeDomain(domain));
  let count = 0;
  for (const e of entries) if ((await entryDomainToken(e, hmacKey)) === token) count++;
  return { ok: true, count, exact: true };
}

// 加密备份导出（v3）：把整个 { auth, entries } 再用主密钥 AES-GCM 包一层，
// 文件里只剩 salt/kdf（不敏感）+ 密文，连主账户名、条目数、域名分组等元数据都看不到。
// 需解锁（用会话内缓存的主密钥字节），导出仍是一键、无需再输主密码。
async function exportBackup() {
  const auth = await getAuth();
  if (!auth) return { ok: false, error: t("err_not_configured") };
  const session = await getSession();
  if (!session || !session.mk) return { ok: false, locked: true, error: t("err_locked") };

  const entries = await getEntries();
  const masterKey = await importAesKeyRaw(new Uint8Array(session.mk));
  const { iv, ct } = await aesEncrypt(masterKey, JSON.stringify({ auth, entries }));
  return { ok: true, backup: { version: 3, salt: auth.salt, kdf: auth.kdf, iv, ct } };
}

async function importBackup({ backup, password }) {
  if (!backup) return { ok: false, error: t("err_backup_invalid") };

  if (backup.version >= 3) {
    // 加密备份：用主密码 + 文件里的 salt/kdf 派生主密钥解开。
    if (!password) return { ok: false, needPassword: true, error: t("err_account_or_pw") };
    let payload;
    try {
      const key = await deriveMasterKey(password, backup.salt, backup.kdf);
      payload = JSON.parse(await aesDecrypt(key, backup.iv, backup.ct));
    } catch {
      return { ok: false, error: t("err_account_or_pw") }; // 主密码错误或文件损坏
    }
    if (!payload || !payload.auth) return { ok: false, error: t("err_backup_invalid") };
    await setAuth(payload.auth);
    await setEntries(payload.entries || []);
    await clearSession();
    return { ok: true };
  }

  // 兼容旧版未加密备份（version 2）。
  if (!backup.auth) return { ok: false, error: t("err_backup_invalid") };
  await setAuth(backup.auth);
  await setEntries(backup.entries || []);
  await clearSession();
  return { ok: true };
}

// 跨导航待保存：内容脚本在提交/离开页面时暂存，目标页加载后取回再提示保存。
// 仅存于内存型 storage.session（仅后台可访问），短时效，取用后即清。
async function stashPending({ domain, username, password, fullUrl }) {
  if (!domain || !username) return { ok: false }; // 密码可选（仅账号）
  await chrome.storage.session.set({
    [PENDING]: { domain, username, password: password || "", fullUrl: fullUrl || "", ts: Date.now() },
  });
  return { ok: true };
}
async function getPending({ domain }) {
  const d = await chrome.storage.session.get(PENDING);
  const p = d[PENDING];
  if (!p || p.domain !== domain || Date.now() - p.ts > PENDING_TTL) return { ok: true, username: null };
  return { ok: true, username: p.username, password: p.password, fullUrl: p.fullUrl, domain: p.domain };
}
async function clearPending() {
  await chrome.storage.session.remove(PENDING);
  return { ok: true };
}

// ---------- 分组注册表（组名 → 颜色） ----------
async function getGroups() {
  const d = await chrome.storage.local.get(STORAGE.GROUPS);
  return { ok: true, groups: d[STORAGE.GROUPS] || {} };
}
async function setGroupColor({ group, color }) {
  group = (group || "").trim();
  if (!group) return { ok: false };
  const d = await chrome.storage.local.get(STORAGE.GROUPS);
  const groups = d[STORAGE.GROUPS] || {};
  if (!color || color === "none") delete groups[group];
  else groups[group] = color;
  await chrome.storage.local.set({ [STORAGE.GROUPS]: groups });
  return { ok: true, groups };
}

// ---------- 环境警告（域名/IP，支持通配符 *）----------
const ENV_CS_ID = "ep-env";

// 标记键：含 * 的通配模式原样保留（如 *.baidu.com、10.4.*.*）；否则规范成 host:端口。
function normEnvKey(input) {
  input = (input || "").trim().toLowerCase();
  if (!input) return "";
  return input.includes("*") ? input : normalizeDomain(input);
}

// 因通配（尤其 IP 段 10.4.*.*）无法表达成 match pattern，env-warning.js 在页面侧自检；
// 故只在「存在任意标记」时注册一个 <all_urls> 脚本，无标记则注销，保持纯净。
async function syncEnvCS() {
  if (!(await hasHostAccess())) return;
  const d = await chrome.storage.local.get(STORAGE.ENV);
  const has = Object.keys(d[STORAGE.ENV] || {}).length > 0;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ENV_CS_ID] });
    if (has && !(existing && existing.length)) {
      await chrome.scripting.registerContentScripts([
        { id: ENV_CS_ID, matches: ["<all_urls>"], js: ["src/env-warning.js"], runAt: "document_start", allFrames: false },
      ]);
    } else if (!has && existing && existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [ENV_CS_ID] });
    }
  } catch {
    /* 无权限/状态不一致时忽略 */
  }
}

// 标记某 host:端口 的颜色：写 ep_env + 注册该 host 脚本 + 立刻注入当前页。
async function getOverrides() {
  const d = await chrome.storage.local.get(STORAGE.OVERRIDES);
  return { ok: true, overrides: d[STORAGE.OVERRIDES] || {} };
}

// 标记某 host:端口 颜色。
// - override=true：写「站点覆盖」(优先级最高)；
// - override 不传（分组触发）：仅当该站点没有覆盖时才采用分组色。
async function armEnv({ domain, color, override }) {
  const key = normEnvKey(domain); // 支持 host:端口 与通配（*.x.com、10.4.*.*）
  if (!key) return { ok: false };
  const d = await chrome.storage.local.get([STORAGE.ENV, STORAGE.OVERRIDES]);
  const env = d[STORAGE.ENV] || {};
  const overrides = d[STORAGE.OVERRIDES] || {};

  if (override) {
    if (!color || color === "none") delete overrides[key];
    else overrides[key] = color;
    await chrome.storage.local.set({ [STORAGE.OVERRIDES]: overrides });
  } else if (overrides[key]) {
    return { ok: true }; // 有站点覆盖时，分组色不得改写
  }

  const effective = overrides[key] || (color === "none" ? null : color);
  if (!effective) delete env[key];
  else env[key] = effective;
  await chrome.storage.local.set({ [STORAGE.ENV]: env });
  await syncEnvCS();

  // 立即注入当前活动标签页（脚本自检是否匹配，免刷新）。
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && /^https?:/.test(tab.url || "")) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/env-warning.js"] });
    }
  } catch {
    /* ignore */
  }
  return { ok: true };
}

// 启动时按 ep_env 恢复环境警告脚本注册（重载/重启后边框仍生效）。
async function restoreEnvCS() {
  await syncEnvCS();
}

// ---------- 动态内容脚本（按需注入，配合 optional_host_permissions）----------
// 安装时不含 <all_urls>；用户在弹窗授权后才把内容脚本注册到所有站点。
const CS_ID = "ep-content";
const CS_FILES = ["src/generator.js", "src/content.js"];
const CS_CSS = ["src/content.css"];

async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}

async function registerCS() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CS_ID] });
    if (existing && existing.length) return;
    await chrome.scripting.registerContentScripts([
      {
        id: CS_ID,
        matches: ["<all_urls>"],
        allFrames: true,
        matchOriginAsFallback: true,
        js: CS_FILES,
        css: CS_CSS,
        runAt: "document_idle",
      },
    ]);
  } catch {
    /* 未授权或已注册时忽略 */
  }
}

async function unregisterCS() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] });
  } catch {
    /* 未注册时忽略 */
  }
}

// 根据当前授权状态，注册或撤销内容脚本。
async function syncContentScripts() {
  if (await hasHostAccess()) await registerCS();
  else await unregisterCS();
}

// 授权后：注册 + 立即注入当前标签页（免去手动刷新页面）。
async function syncAndInject() {
  await syncContentScripts();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && /^https?:/.test(tab.url || "")) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CS_FILES });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: CS_CSS });
    }
  } catch {
    /* 当前页不可注入（如 chrome:// 页）时忽略 */
  }
  return { ok: true };
}

// ---------- 消息路由 ----------

const GATED = {
  SAVE_CREDENTIAL: saveCredential,
  GET_SUGGESTIONS: getSuggestions,
  GET_PASSWORD: getPassword,
  LIST_ALL: listAll,
  REVEAL_PASSWORD: revealPassword,
  UPDATE_ENTRY: updateEntry,
};

const OPEN = {
  SETUP_ACCOUNT: setupAccount,
  UNLOCK: unlock,
  LOCK: lock,
  CHANGE_PASSWORD: changePassword,
  GET_AUTH_STATE: authState,
  GET_SETTINGS: getSettingsMsg,
  SET_SETTINGS: setSettingsMsg,
  HAS_ENTRIES: hasEntries,
  DELETE_ENTRY: deleteEntry,
  EXPORT_BACKUP: exportBackup,
  IMPORT_BACKUP: importBackup,
  STASH_PENDING: stashPending,
  GET_PENDING: getPending,
  CLEAR_PENDING: clearPending,
  SYNC_CS: syncAndInject,
  GET_GROUPS: getGroups,
  SET_GROUP_COLOR: setGroupColor,
  ARM_ENV: armEnv,
  GET_OVERRIDES: getOverrides,
};

async function route(msg) {
  const type = msg?.type;
  const payload = msg?.payload || {};
  if (OPEN[type]) return OPEN[type](payload);

  if (GATED[type]) {
    const session = await getSession();
    if (!session) return { ok: false, locked: true, error: t("err_locked") };

    // 活动时滑动续期。
    const { sliding, unlockMinutes } = await getSettings();
    if (sliding) {
      session.expiresAt = Date.now() + unlockMinutes * 60000;
      await writeSession(session);
    }

    const ctx = {
      privateKey: await importPrivateKey(session.privateJwk),
      hmacKey: await importHmacKey(session.domainKey),
    };
    return GATED[type](payload, ctx);
  }
  return { ok: false, error: "未知请求: " + type };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  route(msg)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 异步响应
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ep-lock") clearSession();
});

// 启动/安装时按当前授权状态恢复内容脚本 + 环境警告脚本；授权变化时同步注册/撤销。
function syncAllScripts() {
  syncContentScripts();
  restoreEnvCS();
}
chrome.runtime.onInstalled.addListener(syncAllScripts);
chrome.runtime.onStartup.addListener(syncAllScripts);
chrome.permissions.onAdded.addListener(syncAllScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
