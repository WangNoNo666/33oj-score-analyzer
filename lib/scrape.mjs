/**
 * scrape.mjs — 33OJ 页面抓取与解析（带磁盘缓存）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ORIGIN, UA } from './auth.mjs';

/* ------------------------------ 工具 ------------------------------ */

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

export function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function fmtDate(ts, withTime = false) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export const monthKey = (ts) =>
  new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);

/* ------------------------------ 缓存 ------------------------------ */

export class DiskCache {
  constructor(dir, ttlMs = 15 * 60 * 1000, disabled = false) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.disabled = disabled;
    if (!disabled) fs.mkdirSync(dir, { recursive: true });
  }
  #file(key) {
    return path.join(this.dir, key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
  }
  get(key) {
    if (this.disabled) return null;
    try {
      const j = JSON.parse(fs.readFileSync(this.#file(key), 'utf8'));
      if (Date.now() - j.savedAt > this.ttlMs) return null;
      return j.value;
    } catch {
      return null;
    }
  }
  set(key, value) {
    if (this.disabled) return;
    try {
      fs.writeFileSync(this.#file(key), JSON.stringify({ savedAt: Date.now(), value }), 'utf8');
    } catch {}
  }
}

/**
 * 进程内缓存，接口与 DiskCache 一致。
 * 在线部署时用它替代磁盘缓存：不写文件、重启即清空，
 * 既避免把多用户数据落盘，也适配云平台的临时文件系统。
 */
export class MemoryCache {
  constructor(ttlMs = 15 * 60 * 1000, maxEntries = 4000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.savedAt > this.ttlMs) { this.map.delete(key); return null; }
    // LRU：命中后挪到队尾
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { savedAt: Date.now(), value });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
  }
}

/* ------------------------------ HTTP ------------------------------ */

/**
 * 带自适应限流的 HTTP 客户端。
 *
 * 33OJ 在请求过快时会返回 403（不是永久禁止，等一会儿就好）。这里做三件事：
 *   1. 匀速放行：所有请求共用一个「下一个可发时刻」，避免并发瞬间打满；
 *   2. 识别突发 403：短时间内多次 403 判定为被限流，指数退避并全局冷却；
 *   3. 区分偶发 403：孤立的 403（例如成绩表本身被锁）只轻量重试，不拖慢整体。
 */
export function makeClient(cookie, opts = {}) {
  const {
    retries = 4,
    minIntervalMs = 60,
    maxIntervalMs = 1200,
    baseCooldownMs = 800,
    maxCooldownMs = 8000,
    burstWindowMs = 15000,
    burstThreshold = 3,
  } = opts;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = {
    nextAt: 0,
    interval: minIntervalMs,
    cooldownUntil: 0,
    cooldown: baseCooldownMs,
    hits: [],
  };
  // 同一个地址反复 403 的，多半是这张成绩表本来就锁着，别再拖慢全局
  const seen403 = new Set();

  const isThrottle = (s) => s === 403 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

  /** 取一个发送时隙；同时受冷却时间约束。 */
  const pace = async () => {
    const now = Date.now();
    const at = Math.max(now, st.nextAt, st.cooldownUntil);
    st.nextAt = at + st.interval + Math.random() * st.interval * 0.35;
    const wait = at - now;
    if (wait > 0) await sleep(wait);
  };

  const onThrottled = (burst) => {
    if (burst) {
      st.cooldown = Math.min(maxCooldownMs, Math.round(st.cooldown * 1.5));
      st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + st.cooldown);
      st.interval = Math.min(maxIntervalMs, Math.round(st.interval * 1.4) + 12);
    } else {
      st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + 1000);
    }
  };

  const onOk = () => {
    st.cooldown = Math.max(baseCooldownMs, Math.round(st.cooldown / 1.5));
    st.interval = Math.max(minIntervalMs, Math.round(st.interval * 0.92));
  };

  /** 判断最近的 403 是否成簇（说明是被限流，而不是这张成绩表本来就锁着）。 */
  const isBurst = () => {
    const now = Date.now();
    st.hits = st.hits.filter((t) => now - t < burstWindowMs);
    return st.hits.length >= burstThreshold;
  };

  return async function get(pathname) {
    const url = pathname.startsWith('http') ? pathname : ORIGIN + pathname;
    let last = { status: 0, html: '', error: null };

    for (let attempt = 0; attempt <= retries; attempt++) {
      await pace();
      try {
        const r = await fetch(url, {
          headers: { cookie, 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
          redirect: 'manual',
        });
        const html = await r.text();

        if (isThrottle(r.status)) {
          last = { status: r.status, html, error: null };

          // 同一地址第二次 403：判定为「这张表本来就看不到」，直接放弃
          if (r.status === 403 && seen403.has(url)) return last;
          seen403.add(url);

          const burst = isBurst();
          st.hits.push(Date.now());
          onThrottled(burst || st.hits.length >= burstThreshold);
          // 孤立 403：只再试一次
          if (!burst && r.status === 403 && attempt >= 1) return last;
          if (attempt >= retries) return last;
          continue;
        }

        onOk();
        return { status: r.status, html, error: null };
      } catch (e) {
        last = { status: 0, html: '', error: e };
        st.hits.push(Date.now());
        onThrottled(true);
        if (attempt >= retries) throw e;
      }
    }
    return last;
  };
}

/** 带并发上限的 map。 */
export async function pMap(items, fn, concurrency = 4, gapMs = 80) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  });
  await Promise.all(workers);
  return out;
}

/* --------------------------- 比赛列表 --------------------------- */

export function parseContestList(html, domain) {
  const out = [];
  const blocks = html.split(/<tbody class="oi33-contest-table__group">/).slice(1);
  const reTid = new RegExp(`<a href="/d/${domain}/contest/([0-9a-f]{24})"[^>]*>([\\s\\S]*?)</a>`);
  for (const b of blocks) {
    const m = b.match(reTid);
    if (!m) continue;
    const ts = [...b.matchAll(/data-timestamp="(\d+)"/g)].map((x) => Number(x[1]));
    if (ts.length < 2) continue;
    out.push({
      tid: m[1],
      title: stripTags(m[2]),
      begin: ts[0],
      end: ts[1],
      rated: /Rated/.test(b),
    });
  }
  return out;
}

export async function listContests(domain, { client, cache, log = () => {} }) {
  const cacheKey = `contests-${domain}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    log(`· 比赛列表来自缓存（${hit.length} 场）`);
    return hit;
  }
  const all = new Map();
  let page = 1;
  let empty = 0;
  while (page <= 60) {
    const { status, html } = await client(`/d/${domain}/contest?page=${page}`);
    if (status !== 200) break;
    const rows = parseContestList(html, domain);
    const fresh = rows.filter((r) => !all.has(r.tid));
    for (const r of rows) all.set(r.tid, r);
    if (!fresh.length) {
      if (++empty >= 2) break;
    } else empty = 0;
    page++;
  }
  const list = [...all.values()].sort((a, b) => a.begin - b.begin);
  cache.set(cacheKey, list);
  log(`· 抓取比赛列表完成：${list.length} 场`);
  return list;
}

/* --------------------------- 成绩板 --------------------------- */

export function parseScoreboard(html) {
  const problems = [];
  const thead = html.match(/<thead[\s\S]*?<\/thead>/i);
  if (thead) {
    for (const m of thead[0].matchAll(/<th class="col--problem"[^>]*>([\s\S]*?)<\/th>/g)) {
      const inner = m[1];
      const title = decodeEntities((inner.match(/data-tooltip="([^"]*)"/) || [])[1] || '');
      const label = stripTags(inner.split(/<br/i)[0]) || '';
      problems.push({ label, title });
    }
  }

  const rows = [];
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbody) return { problems, rows, maxPage: 1 };

  for (const tr of tbody[0].split(/<tr[^>]*>/i).slice(1)) {
    const uid = (tr.match(/data-uid="(\d+)"/) || [])[1];
    if (!uid) continue;
    const totalRaw = (tr.match(/<td class="col--total_score"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
    const total = Number(stripTags(totalRaw));
    const probs = [...tr.matchAll(/<td class="col--problem"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => {
      const t = stripTags(m[1]);
      if (!t || t === '-') return null;
      const nums = t.split('/').map((x) => x.trim()).filter(Boolean);
      const v = Number(nums[nums.length - 1]);
      return Number.isFinite(v) ? v : null;
    });
    rows.push({
      uid: Number(uid),
      uname: stripTags((tr.match(/<a class="user-profile-name[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || ''),
      rank: stripTags((tr.match(/<td class="col--rank"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || ''),
      total: Number.isFinite(total) ? total : null,
      problems: probs,
    });
  }

  const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map((x) => Number(x[1]));
  return { problems, rows, maxPage: pageNums.length ? Math.max(...pageNums) : 1 };
}

export async function getScoreboard(domain, tid, { client, cache }) {
  const cacheKey = `sb-${domain}-${tid}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { status, html } = await client(`/d/${domain}/contest/${tid}/scoreboard`);
  if (status !== 200) {
    // 失败结果不写缓存：403 多数只是被限流，下次重试就好了，
    // 一旦缓存住就会在 TTL 内一直读到「不可用」，把统计悄悄算错。
    return { status, note: `http-${status}`, problems: [], rows: [] };
  }
  const parsed = parseScoreboard(html);
  let rows = parsed.rows;
  for (let p = 2; p <= Math.min(parsed.maxPage, 30); p++) {
    const rp = await client(`/d/${domain}/contest/${tid}/scoreboard?page=${p}`);
    if (rp.status === 200) rows = rows.concat(parseScoreboard(rp.html).rows);
  }
  const res = { status, note: rows.length ? '' : 'no-rows', problems: parsed.problems, rows };
  if (rows.length) cache.set(cacheKey, res); // 空结果同样不缓存
  return res;
}

/* --------------------------- 用户信息 --------------------------- */

export async function getUser(domain, uid, { client, cache }) {
  const cacheKey = `user-${domain}-${uid}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { status, html } = await client(`/d/${domain}/user/${uid}`);
  let uname = '';
  if (status === 200) {
    uname =
      stripTags((html.match(/<h1[^>]*class="[^"]*user-profile-name[^"]*"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '') ||
      stripTags((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s*-\s*33OJ.*$/, '') ||
      '';
  }
  const res = { status, uname: uname || `UID ${uid}` };
  cache.set(cacheKey, res);
  return res;
}
