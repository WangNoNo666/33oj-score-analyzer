#!/usr/bin/env node
/**
 * app/server.mjs — 33OJ 成绩分析器 服务端
 *
 * 零依赖：只用 node:http / node:fs。
 *
 * 运行模式由环境变量 OJ_MODE 决定：
 *   local （默认）  从本机运行的 Edge 自动取会话，产物写 ./out/gui
 *   cloud          用户在网页上填入自己的 OJ Cookie；服务端只做代理，
 *                  不落盘、不缓存会话，产物写系统临时目录
 *
 * 常用环境变量：
 *   PORT / OJ_GUI_PORT   监听端口（默认 8788；云端平台会注入 PORT）
 *   OJ_MODE              local | cloud
 *   OJ_ALLOW_ORIGIN      允许跨域的来源，例如 https://user.github.io ；设了才会发 CORS 头
 *   OJ_NO_OPEN=1         启动时不自动打开浏览器
 *   OJ_CDP_PORT          Edge 调试端口（local 模式）
 *   OJ_JOB_TTL_MS        作业与产物保留时长（默认 2 小时）
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveCookie, validateCookie, cookieFromRequest, looksLikeCookie, CDP_PORT } from '../lib/auth.mjs';
import { DiskCache, MemoryCache, makeClient, listContests } from '../lib/scrape.mjs';
import { availableYears, parseYears } from '../lib/years.mjs';
import { runAnalysis } from '../lib/job.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI_DIR = path.join(HERE, 'ui');

const MODE = (process.env.OJ_MODE || 'local').toLowerCase() === 'cloud' ? 'cloud' : 'local';
const ALLOW_ORIGIN = process.env.OJ_ALLOW_ORIGIN || '';
const JOB_TTL_MS = Number(process.env.OJ_JOB_TTL_MS || 2 * 60 * 60 * 1000);

// local 模式：产物与缓存放在应用目录；cloud 模式：放临时目录，且不缓存会话
const OUT_ROOT = MODE === 'cloud'
  ? path.join(os.tmpdir(), 'oj-report-gui')
  : path.join(ROOT, 'out', 'gui');
const COOKIE_CACHE = MODE === 'cloud' ? null : path.join(ROOT, '.cache', 'cookie.json');

// 共享缓存：本机模式写磁盘，在线模式只放内存（不落盘、重启即清）
const sharedCache = MODE === 'cloud'
  ? new MemoryCache(15 * 60 * 1000, 4000)
  : new DiskCache(path.join(ROOT, '.cache', 'data'), 15 * 60 * 1000, false);

const makeCache = (noCache) => (noCache ? new MemoryCache(1, 0) : sharedCache);
try { fs.mkdirSync(OUT_ROOT, { recursive: true }); } catch {}

/* ------------------------------ 会话 ------------------------------ */

/** 从请求里解析会话；local 模式允许为空（回退到 Edge）。 */
function sessionFrom(req, body) {
  const fromHeader = cookieFromRequest(req);
  if (fromHeader) return fromHeader;
  if (body && typeof body.cookie === 'string' && body.cookie.trim()) return body.cookie.trim();
  return '';
}

/* ------------------------------ 作业 ------------------------------ */

const jobs = new Map();
let seq = 0;

function createJob(params) {
  // 加随机串：作业 ID 会出现在下载链接里，公开部署时不能被枚举
  const id = `job${++seq}-${crypto.randomBytes(6).toString('hex')}`;
  const job = {
    id,
    params,               // 注意：其中不含 cookie
    status: 'running',
    log: [],
    progress: { stage: 'init', message: '准备中…', current: 0, total: 0 },
    result: null,
    error: null,
    clients: new Set(),
    startedAt: Date.now(),
    finishedAt: null,
    outDir: path.join(OUT_ROOT, id),
  };
  jobs.set(id, job);
  return job;
}

function emit(job, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch {}
  }
}

function setProgress(job, p) {
  job.progress = { ...job.progress, ...p };
  job.log.push({ t: Date.now(), stage: p.stage, message: p.message });
  if (job.log.length > 500) job.log.shift();
  emit(job, { type: 'progress', progress: job.progress });
}

function finishJob(job, err) {
  job.finishedAt = Date.now();
  if (err) {
    job.status = 'error';
    // 不要把可能含 cookie 的内容透出去
    job.error = String(err.message || err).replace(/sid(\.sig)?=[^\s;]+/g, 'sid=***');
    emit(job, { type: 'error', message: job.error });
  } else {
    job.status = 'done';
    emit(job, { type: 'done', result: publicResult(job) });
  }
  for (const res of job.clients) { try { res.end(); } catch {} }
  job.clients.clear();
}

function publicResult(job) {
  if (!job.result) return null;
  return {
    id: job.id,
    domain: job.result.domain,
    years: job.result.years,
    tag: job.result.tag,
    meta: job.result.meta,
    files: job.result.files,
    users: job.result.results.map((r) => ({
      overview: r.overview,
      byYear: r.byYear,
      monthly: r.monthly,
      byIndex: r.byIndex,
      entries: r.entries,
      missedCount: r.missed.length,
      unavailable: r.unavailable,
    })),
  };
}

function startJob(params, cookie) {
  const job = createJob(params);
  (async () => {
    try {
      const result = await runAnalysis({
        domain: params.domain,
        uids: params.uids,
        years: params.years,
        concurrency: params.concurrency,
        cacheDir: undefined,
        cache: makeCache(params.noCache === true),
        cookieCacheFile: COOKIE_CACHE,
        outDir: job.outDir,
        cookie: cookie || undefined,
        allowEdge: MODE === 'local',
        titleFallback: params.titleFallback !== false,
        useCache: params.noCache !== true,
        onProgress: (e) => setProgress(job, e),
      });
      job.result = result;
      finishJob(job, null);
    } catch (err) {
      finishJob(job, err);
    }
  })();
  return job;
}

/** 定期清理过期作业与产物。 */
function sweep() {
  const now = Date.now();
  const keep = new Set();
  for (const [id, job] of jobs) {
    if (job.status === 'running') { keep.add(job.outDir); continue; }
    if (now - (job.finishedAt || job.startedAt) < JOB_TTL_MS) { keep.add(job.outDir); continue; }
    try { fs.rmSync(job.outDir, { recursive: true, force: true }); } catch {}
    jobs.delete(id);
  }
  // 清掉临时目录里没有对应作业的残留（例如进程重启后遗留的）
  try {
    for (const e of fs.readdirSync(OUT_ROOT)) {
      const f = path.join(OUT_ROOT, e);
      if (keep.has(f)) continue;
      try { if (now - fs.statSync(f).mtimeMs > JOB_TTL_MS) fs.rmSync(f, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}
setInterval(sweep, 10 * 60 * 1000).unref();

/* ------------------------------ HTTP ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });

function cors(req, res) {
  if (!ALLOW_ORIGIN) return;
  const origin = req.headers.origin || '';
  const allow = ALLOW_ORIGIN === '*' ? '*' : ALLOW_ORIGIN.split(',').map((s) => s.trim()).includes(origin) ? origin : '';
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-oj-cookie');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function json(req, res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  cors(req, res);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    'cache-control': 'no-store',
  });
  res.end(b);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    cors(req, res);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

async function edgeStatus() {
  const out = { cdp: false, browser: null };
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) { const v = await r.json(); out.cdp = true; out.browser = v.Browser; }
  } catch {}
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204).end(); return; }

    /* ---------------- 状态 ---------------- */
    if (p === '/api/status') {
      const cookie = sessionFrom(req);
      const st = { mode: MODE, cdp: false, browser: null, session: false, error: null };

      if (cookie) {
        if (!looksLikeCookie(cookie)) {
          st.error = 'Cookie 格式看起来不对（应当形如 `sid=xxx; sid.sig=yyy`）';
          return json(req, res, 200, st);
        }
        for (const d of ['TYOI']) {
          if (await validateCookie(cookie, d)) { st.session = true; break; }
        }
        if (!st.session) st.error = '这个 Cookie 无效或已过期，请重新登录后复制。';
        return json(req, res, 200, st);
      }

      if (MODE === 'local') {
        const e = await edgeStatus();
        st.cdp = e.cdp;
        st.browser = e.browser;
        if (e.cdp) {
          try {
            const c = await resolveCookie({ cacheFile: COOKIE_CACHE, domain: 'TYOI', log: () => {} });
            st.session = await validateCookie(c, 'TYOI');
          } catch (err) {
            st.error = String(err.message || err);
          }
        } else {
          st.error = `调试端口 127.0.0.1:${CDP_PORT} 未开放`;
        }
      } else {
        st.error = '尚未提供 Cookie';
      }
      return json(req, res, 200, st);
    }

    /* ---------------- 年份 ---------------- */
    if (p === '/api/years' && req.method === 'POST') {
      const body = await readBody(req);
      const domain = body.domain || 'TYOI';
      const cookie = sessionFrom(req, body);
      const session = await resolveCookie({
        cookie: cookie || undefined,
        cacheFile: cookie ? null : COOKIE_CACHE,
        domain,
        allowEdge: MODE === 'local',
        log: () => {},
      });
      const client = makeClient(session);
      const cache = makeCache(body.noCache === true);
      const all = await listContests(domain, { client, cache, log: () => {} });
      return json(req, res, 200, { domain, total: all.length, years: availableYears(all) });
    }

    /* ---------------- 发起作业 ---------------- */
    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const uids = (Array.isArray(body.uids) ? body.uids : String(body.uids || '').split(/[,，\s]+/))
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x > 0);
      if (!uids.length) return json(req, res, 400, { error: '请至少提供一个合法的数字 UID' });
      if (uids.length > 30) return json(req, res, 400, { error: '一次最多分析 30 个用户' });

      let years;
      try { years = parseYears(body.years ?? 'all'); } catch (e) { return json(req, res, 400, { error: e.message }); }

      const cookie = sessionFrom(req, body);
      if (MODE === 'cloud' && !cookie) {
        return json(req, res, 400, { error: '在线模式需要先在页面上填入你的 OJ Cookie' });
      }

      const job = startJob(
        {
          domain: body.domain || 'TYOI',
          uids,
          years,
          concurrency: Math.min(12, Math.max(1, Number(body.concurrency) || 5)),
          titleFallback: body.titleFallback !== false,
          noCache: body.noCache === true,
        },
        cookie
      );
      return json(req, res, 200, { jobId: job.id });
    }

    /* ---------------- 作业快照 ---------------- */
    const mRun = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (mRun) {
      const job = jobs.get(mRun[1]);
      if (!job) return json(req, res, 404, { error: '作业不存在或已过期' });
      return json(req, res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        log: job.log.slice(-60),
        result: job.status === 'done' ? publicResult(job) : null,
      });
    }

    /* ---------------- 进度 SSE ---------------- */
    const mEv = p.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (mEv) {
      const job = jobs.get(mEv[1]);
      if (!job) return json(req, res, 404, { error: '作业不存在或已过期' });
      cors(req, res);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'progress', progress: job.progress })}\n\n`);
      if (job.status === 'done') { res.write(`data: ${JSON.stringify({ type: 'done', result: publicResult(job) })}\n\n`); res.end(); return; }
      if (job.status === 'error') { res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`); res.end(); return; }
      job.clients.add(res);
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(keep); job.clients.delete(res); });
      return;
    }

    /* ---------------- 下载产物 ---------------- */
    const mFile = p.match(/^\/api\/jobs\/([^/]+)\/files\/(.+)$/);
    if (mFile) {
      const job = jobs.get(mFile[1]);
      if (!job || !job.result) return json(req, res, 404, { error: '作业不存在或未完成' });
      const name = path.basename(decodeURIComponent(mFile[2]));
      if (!job.result.files.some((f) => f.name === name)) return json(req, res, 404, { error: '文件不存在' });
      const full = path.join(job.outDir, name);
      if (!full.startsWith(job.outDir)) return json(req, res, 403, { error: '非法路径' });
      let buf;
      try { buf = fs.readFileSync(full); } catch { return json(req, res, 404, { error: '文件已被清理' }); }
      cors(req, res);
      res.writeHead(200, {
        'content-type': name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    /* ---------------- 启动本机 Edge（仅 local） ---------------- */
    if (p === '/api/open-edge' && req.method === 'POST') {
      if (MODE === 'cloud') return json(req, res, 400, { error: '在线模式不支持启动本机 Edge，请直接填写 Cookie' });
      const candidates = [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ];
      const exe = candidates.find((f) => fs.existsSync(f));
      if (!exe) return json(req, res, 500, { error: '找不到 msedge.exe' });
      const profile = path.join(ROOT, '..', '.edge-oj');
      spawn(exe, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check',
        'https://oj.33dai.cn/d/TYOI/login',
      ], { detached: true, stdio: 'ignore' }).unref();
      return json(req, res, 200, { ok: true });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    const msg = String(err.message || err).replace(/sid(\.sig)?=[^\s;]+/g, 'sid=***');
    return json(req, res, 500, { error: msg });
  }
});

/* ------------------------------ 启动 ------------------------------ */

const wantPort = Number(process.env.PORT || process.env.OJ_GUI_PORT || process.argv[2] || 8788);

function listen(port, tries = 12) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else { console.error('启动失败:', e.message); process.exit(1); }
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    const shown = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │       33OJ 成绩分析器 已启动                 │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
    console.log('  模式      : ' + MODE + (MODE === 'cloud' ? '（用户在页面上填 Cookie）' : '（从本机 Edge 自动取会话）'));
    console.log('  界面地址  : ' + shown);
    if (ALLOW_ORIGIN) console.log('  允许跨域  : ' + ALLOW_ORIGIN);
    console.log('');
    console.log('  按 Ctrl+C 退出。');
    console.log('');
    if (process.env.OJ_NO_OPEN !== '1' && MODE === 'local') openBrowser(shown);
  });
}

function openBrowser(url) {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const exe = candidates.find((f) => fs.existsSync(f));
  try {
    if (exe) spawn(exe, [`--app=${url}`, '--window-size=1180,860', '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

listen(wantPort);
