// 强密码生成器 + 强度估算（纯脚本，挂在 globalThis.EPGen，供内容脚本与弹窗共用）。
(function () {
  // 默认排除易混字符：l/I/1/o/O/0。
  const SETS = {
    lower: "abcdefghijkmnpqrstuvwxyz",
    upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
    digit: "23456789",
    symbol: "!@#$%^&*()-_=+[]{};:,.?",
  };

  function pick(pool) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return pool[a[0] % pool.length];
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const r = new Uint32Array(1);
      crypto.getRandomValues(r);
      const j = r[0] % (i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function generate(opts) {
    const o = Object.assign({ length: 16, lower: true, upper: true, digit: true, symbol: true }, opts || {});
    const sets = [];
    if (o.lower) sets.push(SETS.lower);
    if (o.upper) sets.push(SETS.upper);
    if (o.digit) sets.push(SETS.digit);
    if (o.symbol) sets.push(SETS.symbol);
    if (sets.length === 0) sets.push(SETS.lower);

    const len = Math.max(sets.length, Math.min(64, (o.length | 0) || 16));
    const all = sets.join("");
    const chars = [];
    // 保证每个所选字符类至少出现一次
    for (const s of sets) chars.push(pick(s));
    while (chars.length < len) chars.push(pick(all));
    return shuffle(chars).join("");
  }

  // 基于字符池大小的熵估算，映射为 0~4 分。level 为语言无关的键，由 UI 本地化为文案。
  function strength(pw) {
    if (!pw) return { score: 0, level: "empty", bits: 0 };
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
    const bits = Math.round(pw.length * Math.log2(pool || 1));
    let score, level;
    if (bits < 40) { score = 1; level = "weak"; }
    else if (bits < 60) { score = 2; level = "medium"; }
    else if (bits < 80) { score = 3; level = "strong"; }
    else { score = 4; level = "vstrong"; }
    return { score, level, bits };
  }

  globalThis.EPGen = { generate, strength };
})();
