// 非对称加密模块：RSA-OAEP (2048 位, SHA-256)
//
// 设计说明：
//  - 公钥负责「加密」：保存账号/密码时使用，可以放在任何环境。
//  - 私钥负责「解密」：提示账号列表、回填密码时使用，仅保存在本地扩展存储中。
//  - 账号与密码都是短文本，RSA-OAEP(2048, SHA-256) 单次最大可加密
//    256 - 2*32 - 2 = 190 字节，足以覆盖常见账号/密码（含中文 UTF-8）。

const KEY_ALGO = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// 生成密钥对，返回可序列化的 JWK 结构，便于存入 chrome.storage。
export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(KEY_ALGO, true, ["encrypt", "decrypt"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicJwk, privateJwk };
}

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
}

export async function importPrivateKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );
}

export async function encryptText(publicKey, text) {
  const buf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, enc.encode(text));
  return bufToB64(buf);
}

export async function decryptText(privateKey, b64) {
  const buf = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, b64ToBuf(b64));
  return dec.decode(buf);
}

// ---------- 主密码相关：PBKDF2 派生 + AES-GCM 对称加密 ----------
// 用于把 RSA 私钥用「主密码」加密包裹后存盘，解锁时再解出放入会话内存。

export function randomB64(byteLen) {
  const a = new Uint8Array(byteLen);
  crypto.getRandomValues(a);
  return bufToB64(a.buffer);
}

export async function deriveAesKey(password, saltB64, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new Uint8Array(b64ToBuf(saltB64)), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// 由原始字节（如 Argon2id 输出的 32 字节）导入 AES-GCM 密钥。
export async function importAesKeyRaw(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// 域名混淆用的 HMAC 密钥（确定性地把域名映射成不可逆 token）。
export async function importHmacKey(rawB64) {
  return crypto.subtle.importKey(
    "raw",
    b64ToBuf(rawB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function hmacHex(key, text) {
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function aesEncrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { iv: bufToB64(iv.buffer), ct: bufToB64(ct) };
}

export async function aesDecrypt(key, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) },
    key,
    b64ToBuf(ctB64)
  );
  return dec.decode(pt);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
