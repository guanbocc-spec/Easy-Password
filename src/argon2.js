// Argon2id（WASM）封装。底层用 hash-wasm（MIT，WASM 以 base64 内嵌，无网络请求）。
// 该 UMD 文件无 import/export，作为模块导入即执行，向 globalThis.hashwasm 注册 API。
import "./vendor/hash-wasm-argon2.umd.js";

const lib = globalThis.hashwasm;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 用 Argon2id 把主密码派生为 32 字节密钥材料（用作 AES-256-GCM 密钥）。
// params: { t: 迭代轮数, m: 内存KB, p: 并行度 }
export async function argon2idBytes(password, saltB64, params) {
  if (!lib || typeof lib.argon2id !== "function") {
    throw new Error("Argon2 WASM 未就绪");
  }
  return lib.argon2id({
    password,
    salt: b64ToBytes(saltB64),
    iterations: params.t,
    memorySize: params.m,
    parallelism: params.p,
    hashLength: 32,
    outputType: "binary",
  });
}
