/**
 * auth.mjs — 会话获取与校验
 *
 * 33OJ 的 TYOI 等域是私有的，所有请求都需要登录 Cookie。
 * Cookie 无法从 Edge 的磁盘文件里读出来（v20 / App-Bound Encryption 只能在
 * Edge 进程内解密），因此这里通过 DevTools 协议向正在运行的 Edge 索取。
 *
 * 获取顺序：
 *   1. 本地缓存（.cache/cookie.json，默认 30 分钟内有效）
 *   2. 正在运行的 Edge 调试端口（默认 127.0.0.1:9222）
 *
 * 环境变量：
 *   OJ_CDP_PORT   调试端口，默认 9222
 *   OJ_UA         覆盖 User-Agent
 */
import fs from 'node:fs';
import path from 'node:path';

export const ORIGIN = 'https://oj.33dai.cn';
export const UA =
  process.env.OJ_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
export const CDP_PORT = Number(process.env.OJ_CDP_PORT || 9222);

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端（只用 WebSocket，无第三方依赖）                      */
/* ------------------------------------------------------------------ */

function cdpSend(wsUrl, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let ws;
    const timer = setTimeout(() => {
      try { ws && ws.close(); } catch {}
      reject(new Error(`CDP 超时: ${method}`));
    }, timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      clearTimeout(timer);
      return reject(e);
    }
    const id = 1;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败（Edge 是否在运行？）'));
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    });
  });
}

async function cdpListTargets(port) {
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch {
    throw new Error(
      `无法连接 Edge 调试端口 127.0.0.1:${port}\n` +
        `  → 请先双击 start-edge.cmd 打开带调试端口的 Edge，登录 oj.33dai.cn 后保持窗口开着。\n` +
        `  → 注意：日常使用中的普通 Edge 不能被复用（未开放调试端口，且 Cookie 受 App-Bound Encryption 保护）。`
    );
  }
  if (!r.ok) throw new Error(`DevTools 端口返回 HTTP ${r.status}`);
  return r.json();
}

/** 从正在运行的 Edge 中取出指定 URL 的 Cookie 串。 */
export async function cookieFromEdge(port = CDP_PORT, urls = [ORIGIN + '/']) {
  const targets = await cdpListTargets(port);
  const page =
    targets.find((t) => t.type === 'page' && /33dai\.cn/.test(t.url)) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Edge 中没有可用的页面标签');
  const res = await cdpSend(page.webSocketDebuggerUrl, 'Network.getCookies', { urls });
  const cookies = (res && res.cookies) || [];
  if (!cookies.length) throw new Error('Edge 中该站点没有 Cookie —— 会话可能已失效，请重新登录');
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/* ------------------------------------------------------------------ */
/* Cookie 缓存                                                        */
/* ------------------------------------------------------------------ */

export function readCookieCache(cacheFile) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j && typeof j.cookie === 'string' && j.cookie) return j;
  } catch {}
  return null;
}

export function writeCookieCache(cacheFile, cookie) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ cookie, savedAt: Date.now() }, null, 0), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 校验                                                               */
/* ------------------------------------------------------------------ */

/** 用一次真实请求验证 Cookie 是否仍然有效。 */
export async function validateCookie(cookie, domain = 'TYOI') {
  try {
    const r = await fetch(`${ORIGIN}/d/${domain}/contest`, {
      headers: { cookie, 'user-agent': UA },
      redirect: 'manual',
    });
    if (r.status !== 200) return false;
    const html = await r.text();
    if (/data-page="user_login"/.test(html)) return false;
    return /data-page="contest_main"/.test(html);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取得一个可用会话。
 *
 * 三种来源，优先级从高到低：
 *   1. 调用方直接传入的 cookie（在线部署时由用户在自己的浏览器里提供）
 *   2. 磁盘缓存（仅本机模式）
 *   3. 运行中的 Edge（仅本机模式，通过 DevTools 协议）
 *
 * @param {object}  o
 * @param {string}  [o.cookie]      直接提供的 cookie 串，提供了就不再走 Edge
 * @param {string}  [o.cacheFile]   缓存文件路径；传 null 表示不缓存
 * @param {string}  [o.domain]
 * @param {number}  [o.maxAgeMs]
 * @param {boolean} [o.allowEdge]   是否允许回退到本机 Edge，默认 true
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<string>} cookie 串
 */
export async function resolveCookie({
  cookie,
  cacheFile,
  domain = 'TYOI',
  maxAgeMs = 30 * 60 * 1000,
  allowEdge = true,
  log = () => {},
} = {}) {
  // 1. 调用方直接给的 cookie
  if (cookie && String(cookie).trim()) {
    const c = String(cookie).trim();
    if (!(await validateCookie(c, domain))) {
      throw new Error(
        `提供的会话无效或已过期，无法访问 /d/${domain}/。\n` +
          `  → 请重新登录 https://oj.33dai.cn/d/${domain}/login 并复制最新的 Cookie（sid 与 sid.sig）。`
      );
    }
    return c;
  }

  // 2. 缓存
  const cached = cacheFile ? readCookieCache(cacheFile) : null;
  if (cached && Date.now() - (cached.savedAt || 0) < maxAgeMs) {
    if (await validateCookie(cached.cookie, domain)) {
      log('· 使用缓存的会话（有效）');
      return cached.cookie;
    }
    log('· 缓存会话已失效，重新获取');
  }

  if (!allowEdge) {
    throw new Error(
      '没有可用的会话。\n' +
        '  → 在线部署模式需要你在页面上填入自己的 OJ Cookie（详见界面里的「怎么拿到 Cookie」）。'
    );
  }

  // 3. 本机 Edge
  const fromEdge = await cookieFromEdge();
  if (!(await validateCookie(fromEdge, domain))) {
    throw new Error(
      `从 Edge 取到的会话无法访问 /d/${domain}/ —— 请在弹出的 Edge 窗口中登录 https://oj.33dai.cn/d/${domain}/login 后重试`
    );
  }
  if (cacheFile) writeCookieCache(cacheFile, fromEdge);
  log('· 已从 Edge 取得有效会话');
  return fromEdge;
}

/**
 * 从 HTTP 请求里取出用户提供的会话 cookie。
 * 支持 `X-OJ-Cookie` 请求头，或 `?cookie=` 查询参数。
 */
export function cookieFromRequest(req) {
  const h = req.headers['x-oj-cookie'];
  if (h && String(h).trim()) return String(h).trim();
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const q = u.searchParams.get('cookie');
    if (q && q.trim()) return q.trim();
  } catch {}
  return '';
}

/** 基本形状检查，避免把明显不对的字符串发到 OJ。 */
export function looksLikeCookie(s) {
  const t = String(s || '');
  return t.length >= 8 && t.length <= 4096 && t.includes('=');
}
