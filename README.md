# Easy Password 🔐

**Language**: English (current) · [简体中文](README.zh-CN.md)

A browser extension (Manifest V3) for **Google Chrome** and **Microsoft Edge** that securely remembers your web login credentials.
**Fully local, no network, collects nothing.**

> 📖 Illustrated user guide: [English](docs/USER_GUIDE.en.md) · [中文](docs/USER_GUIDE.zh-CN.md)

- **Remember credentials**: prompts to save after login; type the first character(s) of a username (CJK supported) on a login page to get account hints, pick one and the password is decrypted and filled automatically.
- **Account-only (no password)**: sites using phone/email + SMS-code login can be remembered too. The model is "**domain → suggest accounts; account → fill password (if any)**".
- **Intranet-friendly**: the site key is the `host` (**including port**), so domain-less `IP:port` works (e.g. `192.168.1.10:8080`; different ports are treated as different apps).
- **On-load autofill**: the username and password for the current site are filled as soon as a login page loads (most recently used when several; switchable via the dropdown; sign-up/change-password pages are not auto-filled).
- **Asymmetric encryption**: usernames, passwords and domains are stored encrypted with an **RSA-OAEP 2048** public key, decrypted with the private key.
- **Master account guard**: one "master account + master password" guards the whole vault; the master password derives the master key via **Argon2id**, and you must re-confirm periodically (default 30 min, configurable + sliding renewal).
- **Strong-password generator**: one-click high-entropy passwords on sign-up/change-password pages.
- **Broad detection**: supports **nested iframes**, **Shadow DOM** and **custom password fields**. Field classification follows Chromium Autofill's approach — **layered: `autocomplete` is authoritative → `label`/`aria`/`placeholder` text heuristics → name/structure fallback** — with a compact multilingual keyword set to tell login/sign-up/change-password apart.
- **Robust submit detection**: a "capture → flush" model with multiple signals — `form submit`, the clickable control below the password field (**by geometry**), submit-like control clicks, Enter, and **full-page navigation** (credentials are briefly stashed in memory on submit and prompted on the destination page); plus **bias against failed logins** (no prompt if the page stays put with the password field still present).
- **i18n**: UI and prompts are localized via `chrome.i18n` and follow the browser language (Simplified Chinese / English built in).
- **Minimal permissions**: **no host permission is requested at install**; `<all_urls>` is an `optional_host_permissions` and content scripts are registered dynamically only after the user clicks "Grant" (see "Permission design").

> What hits disk is always ciphertext; the plaintext private key lives in memory only while unlocked — see [Security model](#security-model-how-the-private-key--master-password-are-protected-and-where-they-live).

### Encryption & storage at a glance

| Object | Algorithm / handling | Where | On disk? |
|--------|----------------------|-------|----------|
| Master password | Never stored; derives the master key via Argon2id (m=19 MiB, t=2, p=1) | — (memory only, discarded after use) | No |
| RSA private key | Wrapped with the master key (AES-256-GCM) | `storage.local.ep_auth.wrappedPrivate` | Yes (ciphertext) |
| Domain key (HMAC) | Wrapped with the master key (AES-256-GCM) | `storage.local.ep_auth.wrappedDomainKey` | Yes (ciphertext) |
| Username/password/domain | RSA-OAEP public-key encrypted; domain also stored as an HMAC token; `encPassword` may be null (account-only) | `storage.local.ep_entries[]` | Yes (ciphertext) |
| Unlocked session | Plaintext private key + domain key + expiry | `storage.session.ep_session` | **No (memory only)** |
| Pending save | Credentials briefly stashed across navigation (≤120 s, cleared after use) | `storage.session.ep_pending` | **No (memory only)** |
| Group colors / per-site env marks | group→color, host→color (**plaintext labels**, not keys; read by the env-warning script) | `storage.local.ep_groups / ep_env / ep_overrides` | Yes (plaintext, marks only — no credentials) |

## Features

- **Master account + timed re-auth**: create a "master account + master password" on first use. The unlock window is **configurable** (default 30 min; 5/15/30/60/120) with **activity-based sliding renewal**; after timeout or browser restart you must re-enter the master password.
- **Argon2id key derivation**: the master password is derived with **Argon2id (memory-hard, WASM)**, far stronger against GPU brute force than PBKDF2; legacy PBKDF2 data is **auto-upgraded** to Argon2id on next unlock.
- **Domain obfuscation**: saved domains are stored as irreversible HMAC tokens; no plaintext domain hits disk.
- **Remember credentials**: the "save" prompt appears **only after you submit a login/form** (never while typing or switching fields), one click to save encrypted.
- **Asymmetric encryption**: an RSA key pair is generated automatically — public key encrypts (when saving), private key decrypts (hints, autofill).
- **First-character hints**: focusing/typing in the username field shows a dropdown of matching accounts (CJK prefix/substring match, ↑↓ to select, Enter to confirm).
- **Autofill**: pick or fully type an account and the matching password is decrypted and filled.
- **Strong-password generator**: on sign-up/change-password fields, a generator pops up with one-click strong passwords (`crypto.getRandomValues`, excludes look-alike chars, guarantees upper/lower/digit/symbol), length 12–32, live strength bar. The generated password **stays the same across re-focus** (so you can match the confirm field), changing only when you click "Regenerate" or change the length; "Use" fills the password and confirm fields. There's also a 🔑 button + strength bar in the popup.
- **Management popup**: create/unlock the master account, add manually, search, show/copy/delete entries, **click the username to copy it**, **encrypted notes** (editable, searchable — handy for ops rotation/purpose notes), **one-page master-password change**, encrypted backup import/export.
- **Weekly backup reminder**: each Monday (if not yet backed up this week and the vault isn't empty) the popup prompts you to back up; clicking "Back up now" exports an encrypted backup, and **the reminder clears only on a successful export**.

## Authentication model (timed confirmation)

```
master password ──Argon2id(19MiB, t=2, p=1)──▶ AES-GCM master key
                                                │
                ┌───────────────────────────────┼───────────────────────────┬──────────┐
                ▼                                ▼                            ▼          ▼
        wraps RSA private key          wraps domain HMAC key          wraps verifier    …
        stored in storage.local (everything on disk is ciphertext; plaintext private key / domain key / master password are never written)
```

- **Unlock**: the master password decrypts the RSA private key and domain HMAC key; the plaintext is written only to `chrome.storage.session` (**memory, not disk**), with an expiry (default 30 min, configurable in the popup) and a `chrome.alarms` to auto-clear.
- **Sliding renewal**: when enabled, every real use of the vault (save/hint/fill/view) pushes the expiry forward; pure idleness lets it lock.
- **Expiry/restart**: the session dies → private/domain keys vanish from memory → all credential operations are refused, back to the "Confirm identity" screen.
- **Auto-upgrade**: legacy (PBKDF2, plaintext domain) data is re-wrapped with Argon2id and domains converted to HMAC token + encrypted domain on next unlock — transparent, no re-entry.
- **Master password is unrecoverable**: forgetting it means the private key can't be decrypted (that's the point). Use the "encrypted backup" to migrate machines.

## Project layout

```
easy-password/
├─ manifest.json          extension manifest (MV3, default_locale=zh_CN)
├─ _locales/              i18n strings (chrome.i18n)
│  ├─ zh_CN/messages.json Simplified Chinese (default)
│  └─ en/messages.json    English
├─ src/
│  ├─ crypto.js           RSA-OAEP + AES-GCM + PBKDF2/HMAC helpers
│  ├─ argon2.js           Argon2id (WASM) wrapper
│  ├─ vendor/
│  │  └─ hash-wasm-argon2.umd.js   vendored hash-wasm (MIT, embedded WASM)
│  ├─ generator.js        strong-password generator + strength estimate (shared by content & popup)
│  ├─ background.js       Service Worker: master account/unlock / KDF / key mgmt / crypto / storage / routing
│  ├─ content.js          content script: form detection (incl. iframe/shadow DOM/custom fields) / hints / autofill / generator
│  ├─ env-warning.js      env-warning content script: self-checks ep_env (wildcards) and injects a full-screen breathing border
│  └─ content.css         injected UI styles
├─ popup/                 toolbar popup (account management)
│  ├─ popup.html
│  ├─ popup.css
│  └─ popup.js
├─ docs/                  user guides
│  ├─ USER_GUIDE.zh-CN.md Chinese user guide
│  └─ USER_GUIDE.en.md    English user guide
├─ icons/                 extension icons
└─ test/
   ├─ login-test.html            login page (test save / hint / fill)
   └─ change-password-test.html  change-password page (test the generator)
```

## Install (load unpacked)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `easy-password` folder.
4. The 🔐 icon appears in the toolbar.
5. Click the 🔐 icon and press **Grant** at the top to enable on-page autofill/save (see "Permission design").

## Ops workbench (advanced)

Efficiency/safety modules for intranet ops; invisible to ordinary users by default (no groups, no colors = the same minimal experience).

1. **🌐 Full-URL launch**: an entry can store the full login URL (`encFullUrl`, encrypted; auto-captured when saving on a login page). The 🚀 on each row uses `chrome.tabs.create` to open it in a new tab, then autofill kicks in via the existing host:port match.
2. **📌 Pinned side panel**: the header 📌 calls `chrome.sidePanel.open` to pin the UI to the side panel (it no longer closes when you click the page). The panel listens to `tabs.onActivated/onUpdated` and refreshes by the current `host:port`, floating matching accounts to the top.
3. **🚀 Batch group launch**: flat groups (`encGroup`, encrypted). A group header's "Launch all" opens every member with `chrome.tabs.create({active:false})` (silent background); **>8 triggers a `confirm()` safety airbag**.
4. **🎨 Color-driven env warning**: a group can be set to none/red/green; you can also **override per site** (Settings → "Per-site env mark", **higher priority than the group**), with **wildcards**: `*.baidu.com`, `10.4.*.*` (patterns with a port match `host:port`, without a port match `hostname`). On a match the page gets a `pointer-events:none`, very-high-z-index **full-screen breathing border** (prod red 🔴 / test green 🟢, mouse passes through).
   - How: the effective color is written to `ep_env` (`override ?? group color`). Because wildcards (especially IP ranges) can't be expressed as match patterns, when any mark exists a single `<all_urls>` `env-warning.js` is registered that **self-checks and only draws on a match, otherwise does nothing**; with zero marks it's unregistered, keeping things pure.
5. **🧹 Clear & disable the browser's own password manager**: one click runs `chrome.browsingData` (clear browser-saved passwords) + `chrome.privacy.services.passwordSavingEnabled=false` (turn off "offer to save"). Double-confirm + **runtime permission request**, to avoid duplicate save prompts and clean up old plaintext.

> New permissions: `sidePanel`; `scripting` (already present); optional `browsingData`, `privacy` (requested only when you click "Clear & disable"). `side_panel.default_path = popup/popup.html?ctx=panel` — the side panel reuses the same UI as the popup, distinguished by `ctx=panel`.

## Permission design (minimal)

To pass store review and protect privacy, **no host permission is requested at install**:

- Install permissions are only `storage` (local storage), `alarms` (timed lock), `activeTab` (read the current tab's domain), `scripting` (on-demand injection), `sidePanel` (side panel).
- `<all_urls>` is an **`optional_host_permissions`** — not requested at install.
- `browsingData`, `privacy` are **`optional_permissions`** — requested once, only when you click "Clear & disable the browser's own password manager".
- On first use, click **Grant** in the popup (one `chrome.permissions.request` user gesture); the background then registers content scripts via `chrome.scripting.registerContentScripts()`; revoking access auto-unregisters.
- **Before** granting host access, vault management in the popup (add/search/delete, backup, change password) still works — only the on-page hint/fill/save is off.

## Test flow

1. Click the 🔐 icon → press **Grant** to enable on-page features → **create a master account** (master name + password); you're now unlocked.
2. Open `test/login-test.html`, enter a username (e.g. `张三`) and password, click "Log in", then click **Save** in the top-right prompt.
3. Reload, clear the username field, type `张` — the account dropdown should appear.
4. Pick `张三`; the password is decrypted and filled.
5. Test locking: click **Lock** in the popup (or wait out the lock time / restart the browser). Back on the login page, focusing the username field shows "Locked — click the toolbar icon to confirm identity"; unlock to restore filling.
6. Test settings: set "Auto-lock" to 5 min, toggle "Extend on activity", and check the "Key derivation: Argon2id" line (means WASM runs).
7. The popup also offers: search / show / copy / delete, and encrypted backup import/export.
8. Test the generator: open `test/change-password-test.html`, focus the "new password" field → the generator pops up → pick a length, click "Use" → both the password and confirm fields are filled. The popup's add form also has a 🔑. (Note: the save prompt only appears after you submit; the generated password stays stable across re-focus, changing only on "Regenerate".)
9. Test change-password: popup → "Change master password" → on **one page** fill "current + new + confirm" → "Confirm" submits once → back to the main view (saved accounts unaffected, the new master password applies on next unlock).

## Security model: how the private key & master password are protected, and where they live

Everything is **local, no network upload**; keys and data never leave the machine (unless you manually export an encrypted backup). Below: master password, RSA private key, unlocked session, entry storage, and the threat model.

### 1. Master password: never stored anywhere

The master password is **stored neither as plaintext nor as a hash**. It only passes through memory:

```
master password ──Argon2id(salt, m=19MiB, t=2, p=1)──▶ 32 bytes ──▶ AES-256-GCM master key (extractable=false, discarded after use)
```

Only the bits needed for verification hit disk, in `chrome.storage.local`'s `ep_auth`:

| Field | Content | Reversible to the password? |
|-------|---------|-----------------------------|
| `salt` | 16-byte random salt (Base64) | No |
| `kdf` | `{type:"argon2id", t, m, p}` (legacy data: `pbkdf2`) | No |
| `verifier` | AES-GCM ciphertext of the fixed string `ep-verifier:<account>` | No |
| `account` | master account name (plaintext) | — |

On unlock: derive the master key from the entered password + stored `salt` → try to decrypt `verifier` → if it decrypts to the right value, the password is correct. A wrong password won't decrypt, and **the password can't be recovered from the ciphertext** (only offline brute force, which Argon2id's memory-hardness makes very expensive on GPU/ASIC). Argon2id runs via WASM (vendored `hash-wasm`, MIT, WASM embedded as base64, no network); the manifest adds the `'wasm-unsafe-eval'` CSP to allow WASM in the extension.

### 2. RSA private key: only hits disk encrypted with the master password

The private key **never hits disk in plaintext**. After generating the RSA key pair at setup:

```
private key (JWK) ──AES-GCM (master-password-derived key)──▶ wrappedPrivate{iv, ct} ──▶ storage.local
```

`ep_auth.wrappedPrivate` on disk is ciphertext; without the master password the private key can't be recovered → nor any credential. The only plaintext on disk is the RSA **public key** `publicJwk` (public anyway).

### 3. After unlock: where the plaintext private key lives, and for how long

After a successful unlock, the decrypted private key **and domain HMAC key** go into **`chrome.storage.session`**:

| | `chrome.storage.local` | `chrome.storage.session` |
|---|---|---|
| On disk | **Yes** (LevelDB in the profile dir, e.g. `.../Local Extension Settings/<ext id>/`) | **No, memory only** |
| Holds | `ep_auth` (all ciphertext), `ep_entries` (ciphertext), `ep_settings` (lock time etc.) | `ep_session` (plaintext private key + domain key + expiry) |
| Cleared | only by manual delete | on browser close; lazy expiry + `chrome.alarms` timer |

The lock time is **configurable** (`ep_settings.unlockMinutes`, default 30 min); with **sliding renewal** each real op extends the expiry.
i.e. **close the browser / idle past expiry → the plaintext private and domain keys vanish from memory → all credential ops are refused, you must re-enter the master password. Disk only ever holds ciphertext.**

### 4. Credential entries

Each `ep_entries[]` stores: `domainToken`, `encDomain`, `encUsername`, `encPassword` — **no plaintext domain**.

- `domainToken` = `HMAC-SHA256(domain key, domain)`: deterministic, irreversible. Matching the current site just needs one HMAC of the current domain — fast and without leaking the plaintext domain (the domain key is itself wrapped with the master password and only in memory after unlock).
- `encDomain` / `encUsername` / `encPassword`: RSA-OAEP public-key Base64 ciphertext, decrypted with the private key (after unlock) for display/hint/fill.

### 5. What it stops, and what it doesn't (please read)

**Stops**: someone digging through your disk / copying the profile files — they get only ciphertext (including domains), useless without the master password.

**Tightened** (vs early versions):

- ✅ **KDF upgraded to Argon2id** (memory-hard, far stronger vs GPU/ASIC than PBKDF2).
- ✅ **Configurable unlock window + sliding renewal** (default 30 min, down to 5), shrinking how long the plaintext private key stays in memory.
- ✅ **Domains no longer hit disk in plaintext** (HMAC token + RSA ciphertext); a disk attacker can't tell "which sites you have accounts on".

**Still doesn't stop** (inherent trade-offs, be aware):

1. **Within the unlock window**, the plaintext private key is in memory (`storage.session`). Same-machine malware, a malicious extension with debug access, or someone opening DevTools on the Service Worker could in theory read it. A shorter lock time shrinks this window.
2. **Master-password strength is still fundamental** — Argon2id slows brute force, but a weak master password (digits, common words) is still dangerous.
3. **`chrome.storage.local` is not an encrypted container** — the safety comes from "what's stored is ciphertext", not the store itself.
4. Trade-off: with domains encrypted, **while locked it can't tell per-site whether you have an account there**; it only uses "have you saved anything at all" to decide whether to show the unlock hint.

## FAQ

**Q: Forgot the master password — can it be recovered?**
No, by design. The master password isn't stored, and the private key is encrypted with it; without it nobody (including you) can decrypt saved passwords. The only way out is a **reset**: `chrome://extensions` → the extension → "Details" → Remove, or clear its `storage.local` in DevTools, then create a new master account. **A reset loses all saved credentials** (unless you previously exported a backup — but that also needs the original master password, so **memorize it**).
> Tip: use a long passphrase you won't forget but others can't guess.

**Q: Move to a new computer / browser?**
1. Old device: popup → "Export encrypted backup" → `easy-password-backup.json` (**the whole file is encrypted with the master password**, see below).
2. New device: install the extension → popup → "Import backup", choose the file → **enter that backup's master password** to decrypt.
3. After import you'll be **forced to re-unlock**: enter the **original device's master account name + master password**. Done — credentials work as before.
> Since the whole backup is encrypted with the master password, the file alone is useless without it — safe to move via cloud drive / USB.

**Q: Does the backup file leak anything?**
Essentially no. Since v3, export wraps the entire backup (account name, all entries, keys) in **another AES-256-GCM layer keyed by the master password (Argon2id-derived)**. The file holds only `salt` and `kdf` params (for decryption, not sensitive) + ciphertext — **the account name, how many entries, which sites, and timestamps are all hidden**. Without the master password it's random bytes. Export is still one click (using the master key cached in memory while unlocked); the password is only needed on import.

**Q: Why won't a site hint accounts / prompt unlock while locked?**
For privacy, domains are stored encrypted; **while locked the extension can't tell whether "this exact site" has saved accounts** (decrypting the domain needs unlock). So while locked it only decides based on "have you saved any account at all". After unlock, per-site hints and autofill resume immediately.

**Q: Is data uploaded? Do multiple devices sync automatically?**
No upload, **fully local**, no network requests (the Argon2id WASM is embedded too). Data lives in `chrome.storage.local` and **does not use browser account sync**, so devices **don't auto-sync** — migrate with the encrypted backup above.

**Q: Does uninstalling lose data?**
Yes. Uninstall clears the extension's `storage.local`. Export a backup first for anything important.

**Q: Can I change the master password?**
Yes. Unlock, popup → "Change master password", fill "current + new + confirm" on **one page**, click "Confirm" to **submit once**. The private key and domain key are **re-wrapped** with the new master password (saved accounts unaffected, no re-entry).

**Q: A brief hang on unlock/account creation — normal?**
Yes. Argon2id is **memory-hard** (≈19 MiB, multiple passes) — deliberately costly per derivation to resist brute force, usually a fraction of a second. If **creating a master account errors out**, the browser likely couldn't run WASM — see next.

**Q: "Key derivation" doesn't show Argon2id / account creation fails?**
WASM didn't run (CSP restriction or an old browser). Use a recent Chrome/Edge and check the extension's Service Worker errors in `chrome://extensions`. The extension is **fail-fast**: it errors clearly at creation rather than silently downgrading or locking you out.

**Q: Why don't some login pages prompt to save / hint accounts?**
The extension detects login forms heuristically (a visible password field + a nearby username field). A few sites have unusual structures (password field in an iframe, dynamic rendering, non-standard tags) that may be missed. For those, **add the entry manually** in the popup; feedback on page structure is welcome to improve the heuristics.

**Q: Why doesn't the generator pop up?**
Only on **sign-up/change-password-like fields** (two password fields, or `autocomplete="new-password"`, or id/name containing `new/confirm/...`). The "current password" field of a normal login page won't trigger it (so it doesn't disturb autofill). The popup's 🔑 generates one anytime.

**Q: The generator's password keeps changing / the length dropdown is unclickable?**
Not anymore. The generated password is **fixed once generated on first focus** (so you can match the confirm field), changing only on "Regenerate" or a length change; the popover only closes when you click outside it and the password field, so the length dropdown works.

**Q: An intranet site (`IP:port`) lost its port after saving?**
The site key is the `host` (with port), and capture and save use the **same** key, so the port normally isn't lost. If it is, it's usually one of:
1. **Changed code without reloading the extension** — the background Service Worker still runs old logic (using `hostname`, dropping the port). Reload the extension in `chrome://extensions` (refreshing the page isn't enough).
2. **An old record** — entries saved **before** `IP:port` support have no port and can't be back-filled; **delete it and log in/save again**.

**Q: (Dev) changes to `src/` or `manifest.json` don't take effect?**
After changing content-script/background logic you must **reload the extension** in `chrome://extensions`: refreshing the page only re-runs content scripts, **not the background Service Worker**. Changes to `manifest.json`, `_locales/`, or permissions also require a reload (permission changes sometimes need a remove + reload).

## License

Released to the public under **[WTFPL](LICENSE)** (Do What The Fuck You Want To Public License v2) — copy, modify, use commercially, no attribution required.

- ⚠️ **Disclaimer**: WTFPL itself carries no warranty clause, so [LICENSE](LICENSE) appends a separate **NO WARRANTY** notice — the software is provided "as is" with no warranty; any data loss/leak from use is at your own risk. A necessary backstop for a password manager.
- **Third party**: `src/vendor/hash-wasm-argon2.umd.js` comes from [hash-wasm](https://github.com/Daninet/hash-wasm) (MIT, © Dani Biro); its file keeps the original MIT header — please don't remove it.
