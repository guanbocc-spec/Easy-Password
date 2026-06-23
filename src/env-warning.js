// 环境警告内容脚本：自检当前 host 是否命中 ep_env（支持通配符 *.x.com、10.4.*.*），
// 命中则向页面塞一个全屏呼吸边框。
// 关键：pointer-events:none + 极高 z-index → 视觉拉满但鼠标无感穿透，不挡任何操作。
(() => {
  "use strict";
  if (window.__epEnvLoaded) return;
  window.__epEnvLoaded = true;

  const HOST = location.host || location.hostname; // 含端口
  const HOSTNAME = location.hostname; // 不含端口
  const BORDER_ID = "__ep_env_border";
  const STYLE_ID = "__ep_env_style";
  const COLORS = {
    red: "rgba(229, 72, 77, 0.92)",
    green: "rgba(48, 164, 108, 0.92)",
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    // 呼吸式内发光：box-shadow 由弱到强再回弱。
    s.textContent =
      "@keyframes __ep_env_breath{" +
      "0%,100%{box-shadow:inset 0 0 10px 2px var(--ep-c),0 0 6px 1px var(--ep-c)}" +
      "50%{box-shadow:inset 0 0 44px 14px var(--ep-c),0 0 18px 4px var(--ep-c)}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function apply(color) {
    let el = document.getElementById(BORDER_ID);
    if (!color || !COLORS[color]) {
      if (el) el.remove();
      return;
    }
    ensureStyle();
    if (!el) {
      el = document.createElement("div");
      el.id = BORDER_ID;
      el.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(el);
    }
    const c = COLORS[color];
    document.documentElement.style.setProperty("--ep-c", c);
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      border: "5px solid " + c,
      boxSizing: "border-box",
      pointerEvents: "none", // 鼠标穿透，绝不挡操作
      zIndex: "2147483647",
      animation: "__ep_env_breath 1.6s ease-in-out infinite",
    });
  }

  // 含端口的模式比对 HOST，否则比对 HOSTNAME；* 匹配任意字符（含 . :）。
  function matchKey(pattern, target) {
    if (pattern === target) return true;
    if (pattern.indexOf("*") < 0) return false;
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    return re.test(target);
  }
  // 对给定 host（含/不含端口）求颜色。
  function colorForHost(env, host, hostname) {
    if (env[host]) return env[host];
    if (env[hostname]) return env[hostname];
    for (const p of Object.keys(env)) {
      if (matchKey(p, p.indexOf(":") >= 0 ? host : hostname)) return env[p];
    }
    return null;
  }

  // 从堡垒机连接 URL 里解析目标机 IP（如 ...@172.17.51.108:3389 - RDP - administrator）。
  function bastionTargetHost() {
    let s = location.href;
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep raw */
    }
    const m = s.match(/@(\d{1,3}(?:\.\d{1,3}){3})/) || s.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    return m ? m[1] : "";
  }

  async function refresh() {
    try {
      const d = await chrome.storage.local.get(["ep_env", "ep_bastions"]);
      const env = d.ep_env || {};
      const bastions = d.ep_bastions || [];
      // 若当前页是堡垒机：按 URL 里的「目标机 IP」上色（你 RDP 进了哪台，就显示那台的红绿）。
      if (bastions.some((b) => b === HOST || b === HOSTNAME)) {
        const t = bastionTargetHost();
        apply(t ? colorForHost(env, t, t) : null);
      } else {
        apply(colorForHost(env, HOST, HOSTNAME));
      }
    } catch {
      /* 扩展上下文失效时忽略 */
    }
  }

  refresh();
  // 堡垒机是 SPA，切换连接只改 hash → 监听 hashchange 重新判定目标机。
  window.addEventListener("hashchange", refresh);
  // 颜色变更（解除/切换）实时反映，无需刷新页面。
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && (ch.ep_env || ch.ep_bastions)) refresh();
    });
  } catch {
    /* ignore */
  }
})();
