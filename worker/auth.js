/**
 * Worker 鉴权与密码学工具：JWT(HS256) + PBKDF2 密码哈希 + 邀请码生成。
 * 纯 Web Crypto API（Cloudflare Workers 运行时与 Node 22+ 均可用），零依赖。
 */

const PBKDF2_ITER = 100_000;        // 迭代次数
const PBKDF2_HASH = "SHA-256";
const SALT_LEN = 16;                // 盐字节
const KEY_BITS = 256;               // 派生密钥位数
const JWT_EXP = 7 * 24 * 60 * 60;   // 7 天（秒）

// Crockford base32 字母表，去除易混字符 I / L / O
const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_LEN = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- 字节 ↔ hex ---------------- */

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/* ---------------- base64url ---------------- */

function b64urlFromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromStr(str) {
  return b64urlFromBytes(enc.encode(str));
}

function b64urlToBytes(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- 密码哈希（PBKDF2-SHA256） ---------------- */

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: PBKDF2_HASH },
    key, KEY_BITS,
  );
  return { saltHex: toHex(salt), hashHex: toHex(new Uint8Array(bits)) };
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  if (!saltHex || !expectedHashHex) return false;
  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: PBKDF2_HASH },
    key, KEY_BITS,
  );
  return timingSafeEqual(toHex(new Uint8Array(bits)), expectedHashHex);
}

/** 常量时间比较（防计时侧信道） */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- JWT (HS256) ---------------- */

export async function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = b64urlFromStr(JSON.stringify(header)) + "." + b64urlFromStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return data + "." + b64urlFromBytes(new Uint8Array(sig));
}

export async function verifyJwt(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  let sig;
  try { sig = b64urlToBytes(s); }
  catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${h}.${p}`));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(b64urlToBytes(p))); }
  catch { return null; }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

/** 签发包含 sub/role/iat/exp 的 token */
export async function issueToken(username, role, secret) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: username, role, iat: now, exp: now + JWT_EXP }, secret);
}

/* ---------------- 邀请码 ---------------- */

export function generateInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_LEN));
  let s = "";
  for (let i = 0; i < INVITE_LEN; i++) {
    s += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return s;
}

/* ---------------- 校验工具 ---------------- */

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function validatePassword(password) {
  if (typeof password !== "string" || !/[A-Z]/.test(password)) return "密码需包含至少一个大写字母";
  return null;
}
