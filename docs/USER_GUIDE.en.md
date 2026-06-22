# Easy Password — User Guide (English)

> Language: English (current) · [简体中文](USER_GUIDE.zh-CN.md)
>
> A **fully local, offline, zero-data-collection** password keeper for your browser.
> Three things it's about — **simple**, **local**, **offline** — plus an efficiency workbench for intranet ops.

---

## 0. Our promise (read this first)

- **Fully local**: your usernames, passwords and domains are encrypted and stored **only in your own browser** — they **never leave your machine**.
- **No network**: the extension makes **no network requests** while running (even the Argon2id key-derivation is bundled).
- **No collection**: we **do not collect, upload or analyze** anything. No accounts, no servers, no telemetry.
- **The only "network" action**: a file leaves your machine only when **you click "Export encrypted backup"** and transfer it yourself — and even that file is ciphertext.

In one line: **install it, and it works with the network off.**

---

## 1. Install & grant access

1. Open the extensions page: `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `easy-password` folder.
4. The 🔐 icon appears in the toolbar (pinning it is recommended).
5. Click the 🔐 icon and press **Grant** at the top to enable on-page hints / autofill / saving.

> **Why the one-time "Grant"?** To keep permissions minimal and protect privacy, the extension **requests no site access at install**.
> It only works on pages after you click "Grant"; without it you can still manage passwords from the popup. Revoke anytime from the extension's details page.
> The UI language follows your browser language (Simplified Chinese / English).

---

## 2. Step one: create a master account

The first time you click 🔐, you'll **create a master account**:

1. Choose a **master account name** (anything — it identifies you).
2. Choose a **master password** (≥ 6 chars, **memorize it**).
3. Click **Create & unlock**.

The master password is the single key to the whole vault:

- It is **stored nowhere**; it only encrypts/decrypts your data.
- **Forgetting it = your saved passwords are unrecoverable** (that's what makes it secure). Use a long passphrase you won't forget but others can't guess.
- A **fraction-of-a-second hang** on create/unlock is normal — that's Argon2id spending compute to resist brute force.

You're now **unlocked**.

---

## 3. Everyday use

### 3.1 Remember credentials automatically

1. Log in normally with your username and password.
2. **After you click "Log in / Submit"**, a card appears top-right: "Save the password for 'xxx'?"
3. Click **Save** to store it **encrypted**.

> You're only prompted **after submitting** — never while typing or switching fields.
>
> **Phone/email + SMS-code logins (no password) work too**: you'll be asked "Remember this site's account?". Even a **`root` + empty password** login prompts to remember the account. The model is "**domain → suggest accounts; pick an account → fill its password if any**".

### 3.2 Account hints & autofill

1. Back on the site's login page — if you saved an account, **the username and password are filled on load** (the most recent one when several).
2. To switch accounts: click the username field, type the first character(s) (CJK supported) for a dropdown; ↑↓ + Enter, or click one — its **password is decrypted and filled**.
3. **Intranet / no-domain sites**: identified by `IP:port` (e.g. `192.168.1.10:8080`); different ports are remembered as different apps.

> Sign-up / change-password pages are not auto-filled, so they don't interfere with creating a new account.

### 3.3 Strong-password generator (sign-up / change-password)

1. On a sign-up or change-password page, click the **new-password field** — the generator pops up.
2. Pick a **length** (12–32), watch the **live strength bar**.
3. Click **Use** to fill it (and the confirm field too); click **Regenerate** if unhappy.

> The generated password **stays the same across re-focus** so you can match the confirm field; it changes only on "Regenerate" or a length change. The popup's add form also has a 🔑.

---

## 4. Locking & timed re-auth

So nobody can browse your passwords while you're away, Easy Password **locks on a timer**:

- After unlocking there's a **valid window** (default 30 min, configurable in settings).
- It **auto-locks after timeout or browser close**; you must re-enter the master password.
- While locked, focusing a login field shows "Locked — click the toolbar 🔐 icon to confirm". Click it and enter the master password to unlock.
- Click **Lock** (top-right of the popup) to lock immediately.

---

## 5. Manage your passwords (click 🔐)

In the main popup:

- **Add**: collapsed by default — click "＋ Add entry" to expand. Fill the domain (blank = current tab), username, password (**can be blank = account only**), and optional note / group / full login URL, then **Encrypt & save**.
- **Search**: filter by username / domain / **note** / group.
- Per-entry actions:
  - **🚀** (if a full URL is stored): open the login page in a new tab and autofill — see §6.1.
  - **Show / Copy**: reveal / copy the password to clipboard.
  - **📝 Edit**: change the note or group.
  - **Delete**: remove the entry.
  - **Click the username text** = copy the username to clipboard (ops often need to paste it too).
- **Encrypted notes**: a free-form note per entry (e.g. "bastion root, rotate quarterly"), also encrypted and searchable.

---

## 6. Advanced: intranet ops workbench

> Ordinary users see **nothing extra** by default: no groups, no colors = the minimal experience above. The following are efficiency/safety features for heavy ops use.

### 6.1 🚀 Full-URL launch

Intranet admin URLs are long and odd (e.g. `:8030/ui/#/dc1`); remembering only the IP won't reach the login page.
- When you save an account on that login page, the **full URL is captured automatically** (you can also type it in the add form).
- Click **🚀** on the row → opens the URL in a new tab → autofill kicks in by `IP:port`.

### 6.2 📌 Pinned side panel

A normal popup closes the moment you click the page, which is awkward for comparing/copying.
- Click **📌** in the popup header → pin the UI to the browser **side panel**, staying open.
- The panel **refreshes as you switch tabs**: it detects the current `IP:port`, floats matching accounts to the top, the top "Current site" is **click-to-copy**, and the add-form domain follows the current page.

### 6.3 Groups + one-click batch launch

- Tag entries with a **group** (e.g. "Prod patrol", "Test env"); the list groups them.
- Groups are **collapsed by default** (click the name to expand/collapse; the state is remembered).
- A group header's "**Launch all 🚀**" opens every member that has a URL **in the background** (without stealing focus).
- **Safety airbag**: more than 8 in a group triggers a `confirm()` first, so you don't accidentally open too many and crash the browser.

### 6.4 🎨 Color env warning (prevents "ran a test command in production")

- Use the three color dots on a group header to set it to **🔴 red (prod/danger)** or **🟢 green (test/safe)**; **none** = no mark.
- Sites in a marked group get a **full-screen breathing border** (red/green) so you can tell the environment at a glance even when tired; the border **lets the mouse pass through** — it never blocks any button.
- **Per-site override (higher priority than the group)**: Settings → "Per-site env mark" lets you color a specific `host:port` or domain, with **wildcards**:
  - `*.baidu.com` (all subdomains)
  - `10.4.*.*` (the whole IP range, any port)
  - `10.0.0.1:8080` (exact, with port)
- With no colored group and no marks at all, **nothing is injected into any page** — staying pure.

### 6.5 🧹 Clear & disable the browser's own "save password"

The red button in Settings, "**Clear & disable browser passwords**", in one click **clears all passwords saved in the browser** and **turns off its "offer to save passwords"** — so it stops competing with this extension and old plaintext records are wiped.
- It **double-confirms** (irreversible) and **requests the needed permissions on the spot** (not requested otherwise).
- Note: this clears the **browser's built-in** password store, not this extension's vault.

---

## 7. Settings (bottom of the popup)

- **Per-site env mark**: see §6.4.
- **Clear & disable browser passwords**: see §6.5.
- **Auto-lock**: pick 5 / 15 / 30 / 60 / 120 minutes. Shorter is safer.
- **Extend on activity**: when on, using the vault keeps pushing the expiry forward; only true idleness lets it lock.
- **Change master password**: on **one page** fill "current + new + confirm" and submit once. Saved accounts are unaffected — no re-entry.
- The "Key derivation: Argon2id" line means the crypto engine is running.

---

## 8. Backup & moving computers

Data is **local only and never auto-synced**; migrate with an encrypted backup:

1. Old device: popup → **Export encrypted backup** → `easy-password-backup.json`.
2. New device: install the extension → **Import backup**, choose the file → **enter that backup's master password** to decrypt.
3. After import you'll be asked to **re-unlock**: enter the **original device's master account name + master password**.

> The whole backup is **encrypted with the master password**: the account name, how many entries, and which sites are involved are all hidden — it holds only the salt/params and ciphertext. Useless without the master password, so it's safe to move via cloud drive / USB.

**Weekly reminder**: each Monday (if not yet backed up this week and the vault isn't empty), opening the popup shows a "Weekly backup reminder"; click **Back up now** to download this week's backup. **The reminder clears only on a successful export.** "Later" dismisses it for now and it returns next time.

---

## 9. FAQ (quick)

- **Forgot the master password?** Not recoverable. You can only remove the extension and create a new master account (losing saved data, unless you have an unlockable backup).
- **Is data uploaded / do devices auto-sync?** No upload, fully local; no auto-sync — migrate with an encrypted backup.
- **Does uninstalling lose data?** Yes — export a backup first.
- **A site doesn't prompt to save / hint?** A few sites have unusual form structures; **add the entry manually** in the popup.
- **A change to settings/features didn't take effect?** Usually the **extension wasn't reloaded** — click "Reload" on it in `chrome://extensions`; refreshing the page isn't enough.
- **Account creation errors / derivation isn't Argon2id?** The browser couldn't run WASM — use a recent Chrome/Edge.

---

**Simple, local, offline, out of your way — with an extra efficiency workbench for ops.**
