#!/usr/bin/env node
/**
 * oj-user.mjs — 33OJ 用户成绩自动抓取与分析
 *
 * 用法:
 *   node oj-user.mjs <uid> [选项]
 *
 * 选项:
 *   --domain <名>          数据域，默认 TYOI
 *   --years <年[,...]>     统计年份，支持 2026 / 2024,2025 / 2024-2026 / all，默认当前年份
 *   --out <目录>           输出目录，默认 ./out/<uid>
 *   --concurrency <n>      并发数，默认 5
 *   --no-cache             忽略磁盘缓存，强制重新抓取
 *   --no-title-year        不按标题兜底归属年份
 *   --json                 额外输出一份 JSON
 *   --help                 显示帮助
 *
 * 例:
 *   node oj-user.mjs 1041
 *   node oj-user.mjs 968 --years 2024-2026
 *   node oj-user.mjs 1020 --years all --out ./out/xihegudi
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCookie } from './lib/auth.mjs';
import { DiskCache, makeClient, listContests, getScoreboard, getUser, pMap, fmtDate } from './lib/scrape.mjs';
import { availableYears, selectContests } from './lib/years.mjs';
import { analyze, renderMarkdown, renderConsole } from './lib/analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const opts = {
    domain: 'TYOI',
    years: String(new Date().getFullYear()),
    out: null,
    concurrency: 5,
    cache: true,
    json: false,
    titleYear: true,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--domain') opts.domain = argv[++i];
    else if (a === '--years' || a === '--year') opts.years = String(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 5);
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--no-title-year') opts.titleYear = false;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new Error(`未知选项: ${a}`);
    else rest.push(a);
  }
  if (!opts.help) {
    const uid = Number(rest[0]);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('请提供合法的数字 UID，例如: node oj-user.mjs 1041');
    opts.uid = uid;
  }
  return opts;
}

const HELP = `
33OJ 用户成绩分析工具

  node oj-user.mjs <uid> [选项]

选项
  --domain <名>        数据域，默认 TYOI
  --years <年[,...]>   统计年份：2026 / 2024,2025 / 2024-2026 / all   默认当前年份
  --out <目录>         输出目录，默认 ./out/<uid>
  --concurrency <n>    并发抓取数，默认 5
  --no-cache           忽略磁盘缓存
  --no-title-year      不按标题兜底归属年份
  --json               额外输出 JSON
  --help               显示本帮助

示例
  node oj-user.mjs 1041
  node oj-user.mjs 968 --years 2024-2026
  node oj-user.mjs 1020 --years all --out ./out/xihegudi

前置条件
  需要一个已登录 oj.33dai.cn 的 Edge 实例在 9222 端口开放调试。
  双击 start-edge.cmd 打开它，登录后保持窗口开着即可。
`;

/* ------------------------------ 主流程 ------------------------------ */

const t0 = Date.now();
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`✗ ${e.message}\n`);
  console.error(HELP.trim());
  process.exit(1);
}
if (opts.help) {
  console.log(HELP.trim());
  process.exit(0);
}

const log = (s) => console.log(s);
const outDir = path.resolve(opts.out || path.join(HERE, 'out', String(opts.uid)));

async function main() {
  log(`▶ 33OJ 成绩分析  uid=${opts.uid}  domain=${opts.domain}  years=${opts.years}`);

  const cookie = await resolveCookie({
    cacheFile: path.join(HERE, '.cache', 'cookie.json'),
    domain: opts.domain,
    log,
  });

  const client = makeClient(cookie);
  const cache = new DiskCache(path.join(HERE, '.cache', 'data'), 15 * 60 * 1000, !opts.cache);

  /* 1. 比赛列表 */
  const all = await listContests(opts.domain, { client, cache, log });
  log(`· 可用年份: ${availableYears(all).map((y) => `${y.year}(${y.count}场)`).join('  ')}`);
  const { contests, byTitle } = selectContests(all, opts.years, { titleFallback: opts.titleYear });
  log(
    `· 选中 ${contests.length} 场` +
      (byTitle.length
        ? `（其中 ${byTitle.length} 场按标题归属，时间戳疑似录入错误：${byTitle.map((c) => c.title).join('、')}）`
        : '')
  );
  if (!contests.length) {
    log('× 该年份范围内没有比赛，退出');
    process.exit(1);
  }

  /* 2. 成绩板 */
  log(`· 抓取成绩表（并发 ${opts.concurrency}）…`);
  let done = 0;
  const boards = await pMap(
    contests,
    async (c) => {
      const sb = await getScoreboard(opts.domain, c.tid, { client, cache });
      done++;
      if (done % 10 === 0 || done === contests.length) process.stdout.write(`\r  ${done}/${contests.length}   `);
      return [c.tid, sb];
    },
    opts.concurrency
  );
  process.stdout.write('\n');
  const scoreboards = new Map(boards);

  /* 3. 用户名 */
  let uname = `UID ${opts.uid}`;
  for (const [, sb] of scoreboards) {
    const r = sb.rows.find((x) => x.uid === opts.uid);
    if (r && r.uname) { uname = r.uname; break; }
  }
  if (uname === `UID ${opts.uid}`) {
    try {
      const u = await getUser(opts.domain, opts.uid, { client, cache });
      if (u.uname) uname = u.uname;
    } catch {}
  }
  log(`· 用户名: ${uname}`);

  /* 4. 分析 */
  const res = analyze({ uid: opts.uid, uname, domain: opts.domain, contests, scoreboards });
  res.years = opts.years;

  if (!res.entries.length && !res.missed.length) {
    log(`× ${uname} 在该范围内没有任何成绩记录（成绩表可能全部不可用）`);
  }

  /* 5. 输出 */
  fs.mkdirSync(outDir, { recursive: true });
  const safe = uname.replace(/[\\/:*?"<>|\s]/g, '_');
  const tag = opts.years === 'all' ? 'all' : String(opts.years).replace(/,/g, '_');

  const mdPath = path.join(outDir, `${safe}-${opts.uid}-成绩分析-${tag}.md`);
  fs.writeFileSync(mdPath, renderMarkdown(res), 'utf8');

  const csvEsc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (rows) =>
    rows.length
      ? '\uFEFF' + [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvEsc).join(','))].join('\r\n')
      : '';

  const csvPath = path.join(outDir, `${safe}-${opts.uid}-逐场明细-${tag}.csv`);
  fs.writeFileSync(
    csvPath,
    toCsv(
      [...res.entries]
        .sort((a, b) => a.begin - b.begin)
        .map((e) => ({
          日期: fmtDate(e.begin),
          年份: e.year,
          比赛名称: e.title,
          比赛ID: e.tid,
          得分: e.score,
          排名: e.rank ?? '',
          参赛人数: e.fieldSize,
          全场平均分: e.fieldAvg,
          全场中位数: e.fieldMed,
          全场最高分: e.fieldMax,
          与均分差: e.delta,
          击败率百分比: e.beatRate ?? '',
        }))
    ),
    'utf8'
  );

  const probPath = path.join(outDir, `${safe}-${opts.uid}-每题得分-${tag}.csv`);
  fs.writeFileSync(
    probPath,
    toCsv(
      res.entries.map((e) => ({
        日期: fmtDate(e.begin),
        比赛名称: e.title,
        ...Object.fromEntries(e.problems.map((v, i) => [e.problemsMeta[i]?.label || `T${i + 1}`, v ?? ''])),
        总分: e.score,
      }))
    ),
    'utf8'
  );

  let jsonPath = '';
  if (opts.json) {
    jsonPath = path.join(outDir, `${safe}-${opts.uid}-分析-${tag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(res, null, 1), 'utf8');
  }

  console.log('');
  console.log(renderConsole(res));
  console.log('');
  console.log('输出文件:');
  for (const f of [mdPath, csvPath, probPath, jsonPath].filter(Boolean)) console.log('  ' + f);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(`\n✗ ${e && e.message ? e.message : e}`);
  process.exit(1);
});
