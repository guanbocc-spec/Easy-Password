# Chrome Web Store — 上架素材 / Store Listing

> 维护用：商店「详情描述」与各权限「使用理由」的中英文文案。改版时直接在这里改。
> Source of truth for the Web Store description and per-permission justifications (zh + en).

提醒 / Note：商店描述里**慎用脏字**。WTFPL 全称含 F-word，正文一律用缩写 **WTFPL**，不要展开全称。

---

## 一、权限使用理由 / Permission justifications

填入开发者后台「为什么需要此权限」框。要点：对应哪个**用户可见功能**、是否**用户主动触发**、是否**运行时才申请**。

### `sidePanel`

**中文**
> 用于「📌 固定到侧边栏」功能：用户点击弹窗中的 📌 按钮后，调用 `chrome.sidePanel.open` 将本扩展的密码库界面固定到浏览器侧边栏，使其在用户跨标签页操作时保持常驻（默认弹窗在点击网页后会自动关闭）。仅由用户显式点击触发，不做任何后台或自动行为。

**English**
> Used for the "📌 Pin to side panel" feature: when the user clicks the 📌 button in the popup, we call `chrome.sidePanel.open` to pin the extension's password-vault UI into the browser side panel so it stays open while the user works across tabs (the default popup closes on any page click). Triggered only by an explicit user click; no background or automatic use.

### `browsingData` （可选权限 / optional）

**中文**
> 仅用于「🧹 清除并禁用浏览器自带密码」功能：当用户在设置中主动点击该按钮并二次确认后，调用 `chrome.browsingData`（`passwords: true`）一次性清除浏览器自带保存的密码，避免与本扩展的密码库重复并清理旧明文。该权限为 `optional_permissions`，安装时不申请，仅在用户点击该功能时运行时请求；绝不在后台或自动清除任何数据。

**English**
> Used only for the "🧹 Clear & disable browser passwords" feature: when the user explicitly clicks that button in Settings and confirms, we call `chrome.browsingData` (`passwords: true`) once to clear the browser's built-in saved passwords, avoiding duplication with this extension's vault and wiping old plaintext. It is an `optional_permission`, not requested at install — only requested at runtime when the user triggers the feature; never used to clear any data automatically or in the background.

### `privacy` （可选权限 / optional）

**中文**
> 仅用于「🧹 清除并禁用浏览器自带密码」功能：当用户主动点击该按钮并确认后，通过 `chrome.privacy.services.passwordSavingEnabled` 关闭浏览器的「提示保存密码」开关，使本扩展作为唯一的密码管理器、不被浏览器自带功能重复弹窗。该权限为 `optional_permissions`，安装时不申请，仅在用户点击该功能时运行时请求；不读取或修改任何其他隐私/浏览设置。

**English**
> Used only for the "🧹 Clear & disable browser passwords" feature: when the user explicitly clicks that button and confirms, we set `chrome.privacy.services.passwordSavingEnabled` to off to disable the browser's "offer to save passwords", so this extension is the single password manager and isn't duplicated by the browser's prompt. It is an `optional_permission`, not requested at install — only requested at runtime on the user's action; we do not read or change any other privacy/browsing setting.

> 若后台还要 `<all_urls>` / `scripting` / `activeTab` 的理由：核心功能（账号自动提示、回填、保存）需要在用户访问的网页上运行内容脚本；`<all_urls>` 为 `optional_host_permissions`，**安装时不索取**，用户首次点「授权」后才动态注册内容脚本。

---

## 二、商店详情描述（中文）

**Easy Password 🔐 — 安全、简单、100% 本地运行的网页密码管理器**

还在为记不住密码发愁，或者在所有网站重复使用同一个弱密码吗？Easy Password 是一款轻量浏览器扩展，帮你记住所有登录账号和密码，让你彻底告别健忘。

最重要的是？**它完全离线运行。** 你的数据绝不上传任何云端服务器——密码只会安全地留在你自己的电脑上。

### ✨ 为什么选择 Easy Password？

- **超方便的自动回填**：打开登录页，已存过的账号密码**自动填好**；多个账号时，在账号框输入第一个字、从下拉里选一个，一秒闪电登录。
- **聪明的不打扰提示**：输入过程中绝不弹窗烦你，**只有你成功提交登录后**才贴心地问要不要保存。
- **验证码登录也能记**：手机号/邮箱 + 短信验证码这类**没有密码**的登录，也能帮你记住账号，下次自动填上。
- **只需记住一个主密码**：告别几十个密码的混乱，一个足够强的主密码就能解锁并守护整个密码库。
- **离开即自动锁定**：一段时间没操作（默认 30 分钟，可调）自动上锁，防身边人偷看。
- **一键生成强密码**：注册或改密码时自动识别页面、弹出生成器，一点就生成超强随机密码并自动填好确认框。
- **备注与快速复制**：给每个账号写一句说明（如“堡垒机 root，季度轮换”）并可搜索；**点一下账号名即可复制**，账号密码都顺手。
- **内网友好**：支持没有域名的 `IP:端口`（如 `192.168.1.10:8080`），不同端口当作不同系统分别记忆。

### 🧰 为内网运维准备的高效工作台（普通用户无感）

不建分组、不开颜色时，它就是上面的极简体验；需要时，这套工具能大幅提速：

- **🚀 一键直达**：为后台存下完整登录地址，列表里点 🚀 直接新开标签进入登录页并自动回填，不再手敲长地址。
- **📌 侧边栏常驻**：把界面固定到浏览器侧边栏，点网页也不关闭；切换标签时自动识别当前站点、把对应账号顶到手边。
- **🗂️ 分组 + 一键开一片**：把多个监控/管理后台归到一组，每天巡检时「全部启动」一次性在后台打开（超过 8 个会先确认，防误触）。
- **🎨 红绿环境警告（防误操作）**：把分组或某个站点标成 🔴 生产 / 🟢 测试，页面四周会出现**呼吸式彩色边框**，熬夜也一眼分清环境，再也不怕“在生产敲了测试命令”；边框**鼠标可穿透**，绝不挡操作。支持通配符（如 `*.公司域名`、`10.4.*.*`）。
- **🧹 清理并禁用浏览器自带密码**：一键清空浏览器自己保存的全部密码、并关掉它的“提示保存密码”，避免和本扩展重复弹窗、清掉旧的明文记录。
- **📅 每周备份提醒**：每周一温馨提醒导出一次加密备份，点一下即可，数据更安心。

### 🛡️ 真正的隐私：它为什么绝对安全？

市面上大多数密码管理器会把数据传到他们的服务器，一旦被黑，你的密码就有泄露风险。Easy Password 彻底打破这种做法：

- **无云端、无服务器**：你的账号密码经高级加密后直接存在你自己的浏览器里。我们（开发者）**没有任何途径**查看你的数据。
- **军规级加密**：主密码采用 **Argon2id**（抗暴力破解的内存硬算法）派生密钥，账号密码用 **RSA 非对称加密**保存。
- **黑客拿走也是瞎的**：就算有人偷走电脑或拷走浏览器文件，看到的也只是一堆乱码；**连你存过哪些网站，在硬盘里都被打乱隐藏**。
- **严格的内存保护**：解密用的“临时钥匙”只在你解锁期间短暂存在于内存，一旦关闭浏览器或锁定到期，**这把钥匙就彻底消失，不留痕迹**。
- **最小权限**：**安装时不申请任何网站访问权限**；只有你亲手点「授权」后才在网页上工作，清理浏览器密码等敏感操作也都是**用时才申请权限**。

### 🚀 只需 3 步，轻松上手

1. 点击工具栏 🔐 图标 →「创建主账户」。
2. 设一个主账户名，和一个你**绝不会忘**的强主密码。
3. 打开任意网站正常登录，右上角弹提示时点 **保存** 即可！

### 💬 常见问题（FAQ）

**Q：忘记主密码怎么办？能找回吗？**
因为极度重视隐私，本扩展不设服务器、绝不保存你的主密码——这意味着我们**无法帮你找回**，也无法恢复数据。请选一个你熟悉、别人猜不到的长口令，或抄在纸上藏在安全处。

**Q：换电脑了，密码怎么转过去？**
很简单：在扩展里点「导出加密备份」得到一个**强加密文件**，通过 U 盘/邮件传到新电脑，点「导入备份」并输入原主密码即可无缝恢复。备份文件强加密，路上被截获也打不开。

**Q：支持手机和多设备自动同步吗？**
不支持。为 100% 杜绝云端泄露风险，本扩展完全本地运行、不联网。多设备之间请用上面的“加密备份”手动迁移。

### 📜 开源与协议

本扩展以 **WTFPL**（Do What The Fuck You Want To Public License）开源——**随便用、随便改、可商用、无需署名**。

> 🛠️ 本插件为作者自用产物，随缘更新。100% 纯本地、不联网、不收集任何数据。
> ⚠️ 按“现状”提供，不作任何担保；**数据丢了概不负责，爱用用，不用拉倒**。

---

## 三、Store description (English)

**Easy Password 🔐 — Secure, Simple, 100% Local Password Management**

Tired of forgetting passwords, or reusing the same weak one everywhere? Easy Password is a lightweight browser extension that remembers all your logins so you don't have to.

Best of all? **It works completely offline.** Your data never uploads to the cloud — your passwords stay exactly where they belong: safely on your own computer.

### ✨ Why You'll Love Easy Password

- **Effortless autofill**: saved credentials are filled the moment a login page loads; with several accounts, type the first letter of the username and pick one from the dropdown for an instant login.
- **Smart, quiet saving**: it never nags while you type — it only offers to save **after you successfully log in**.
- **Remembers code-based logins too**: phone/email + SMS-code logins (**no password**) can be remembered as well, and the account is filled next time.
- **One master password**: stop juggling dozens of passwords — one strong master password locks and unlocks your entire vault.
- **Auto-lock when you step away**: after a period of inactivity (default 30 min, adjustable) it locks itself to keep snooping eyes out.
- **Instant strong passwords**: on sign-up/change-password pages it detects the field, pops a generator, and fills both the password and confirm fields in one click.
- **Notes & quick copy**: add a note per account (e.g. "bastion root, rotate quarterly") and search by it; **click the username to copy it** — both username and password at your fingertips.
- **Intranet-friendly**: supports domain-less `IP:port` (e.g. `192.168.1.10:8080`); different ports are remembered as different systems.

### 🧰 An efficiency workbench for intranet ops (invisible to everyone else)

With no groups and no colors it's just the minimal experience above; when you need it, this toolkit is a big speed-up:

- **🚀 One-click launch**: store an admin panel's full login URL, click 🚀 in the list to open it in a new tab and autofill — no more typing long addresses.
- **📌 Pinned side panel**: pin the UI to the browser side panel so it stays open while you click around; it follows tab switches and floats the matching account to the top.
- **🗂️ Groups + open a whole set at once**: group your monitoring/admin panels and "Launch all" to open them in the background for your daily patrol (more than 8 asks for confirmation, to avoid accidents).
- **🎨 Red/green environment warning (mistake-proofing)**: mark a group or a specific site as 🔴 production / 🟢 test, and the page gets a **breathing colored border** so you can tell the environment at a glance — never "run a test command in production" again. The border **lets the mouse pass through** and never blocks anything. Wildcards supported (e.g. `*.your-domain`, `10.4.*.*`).
- **🧹 Clear & disable the browser's own "save password"**: one click wipes all passwords saved in the browser and turns off its "offer to save", so it stops competing with this extension and old plaintext is gone.
- **📅 Weekly backup reminder**: a gentle Monday nudge to export an encrypted backup — one click, more peace of mind.

### 🛡️ Real Privacy: What Makes It Safe?

Most password managers store your data on their servers. If they get hacked, your passwords could leak. Easy Password does things differently:

- **No cloud, no servers**: your accounts and passwords are encrypted and stored directly inside your browser. We (the developer) have **zero access** to your data.
- **Strong encryption**: the master password derives keys via **Argon2id** (a memory-hard, brute-force-resistant algorithm); credentials are stored with **RSA asymmetric encryption**.
- **Invisible to hackers**: even if someone steals your computer or your files, they see only scrambled gibberish — and **even the names of the sites you've saved are randomized and hidden** on disk.
- **Strict memory protection**: the key that unlocks your passwords lives only in temporary memory while you're actively using it. The moment you close the browser or the timer runs out, **that key vanishes completely**.
- **Minimal permissions**: **no site-access permission is requested at install**; it only works on pages after you click "Grant", and sensitive actions (like clearing browser passwords) **request permission only when used**.

### 🚀 Getting Started in 3 Easy Steps

1. Click the 🔐 icon in your toolbar → **Create Master Account**.
2. Choose a master username and a strong master password you **won't forget**.
3. Go to any website, log in, and click **Save** when the prompt appears. That's it!

### 💬 FAQ

**Q: What if I forget my master password?**
Because we take privacy seriously, we use no servers and never store your password — which means it's **impossible for us to recover it or your data**. Choose a master password you'll remember, or write it down and keep it somewhere safe.

**Q: Can I move my passwords to a new computer?**
Yes! Export a highly **encrypted backup file** from the extension, move it via USB or email, click "Import backup" and enter your original master password to restore everything. The backup is strongly encrypted, so it's safe even if intercepted.

**Q: Does it sync automatically across phones and computers?**
No. To guarantee 100% safety from cloud-database leaks, it runs entirely locally and offline. Transfer between devices manually using the encrypted backup above.

### 📜 Open Source & License

Released under the **WTFPL** (Do What The Fuck You Want To Public License) — **use it, change it, sell it, no attribution required**.

> 🛠️ This extension is a personal project built for my own use; updates are casual.
> 🔒 100% local, completely offline, zero data collection.
> ⚠️ Provided "as is" with no warranty; **not responsible for any data loss — take it or leave it**.
