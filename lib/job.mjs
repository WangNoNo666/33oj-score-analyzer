/**
 * job.mjs — 抓取 + 分析作业引擎
 *
 * 把「解析会话 → 拉比赛列表 → 按年份筛选 → 并发抓成绩表 → 逐用户分析 → 落盘」
 * 封装成一个带进度回调的函数，供 GUI 服务和命令行共用。
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveCookie } from './auth.mjs';
import { DiskCache, makeClient, listContests, getScoreboard, getUser, pMap, fmtDate } from './scrape.mjs';
import { availableYears, selectContests } from './years.mjs';
import { analyze, renderMarkdown } from './analyze.mjs';

export const csvEsc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) =>
  rows.length
    ? '\uFEFF' + [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvEsc).join(','))].join('\r\n')
    : '';

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]/g, '_');

/**
 * @param {object} o
 * @param {string}   o.domain
 * @param {number[]} o.uids
 * @param {string|number[]|'all'} o.years
 * @param {number}   o.concurrency
 * @param {string}   o.cacheDir        磁盘缓存目录
 * @param {string}   o.cookieCacheFile cookie 缓存文件
 * @param {string}   o.outDir          输出目录
 * @param {boolean}  o.titleFallback
 * @param {boolean}  o.useCache
 * @param {(e:object)=>void} o.onProgress
 */
export async function runAnalysis(o) {
  const {
    domain = 'TYOI',
    uids,
    years = 'all',
    concurrency = 5,
    cacheDir,
    cache: injectedCache,     // 直接注入一个缓存实例（在线模式用内存缓存）
    cookieCacheFile,
    outDir,
    cookie,                 // 用户直接提供的会话（在线部署模式）
    allowEdge = true,       // 是否允许回退到本机 Edge
    titleFallback = true,
    useCache = true,
    onProgress = () => {},
  } = o;

  const report = (stage, message, extra = {}) => onProgress({ stage, message, ...extra });

  /* 1. 会话 */
  report('session', cookie ? '正在验证会话…' : '正在获取登录会话…');
  const session = await resolveCookie({
    cookie,
    cacheFile: cookie ? null : cookieCacheFile,
    domain,
    allowEdge,
    log: (m) => report('session', m),
  });
  const client = makeClient(session);
  const cache = injectedCache || new DiskCache(cacheDir, 15 * 60 * 1000, !useCache || !cacheDir);

  /* 2. 比赛列表 */
  report('contests', '正在拉取比赛列表…');
  const all = await listContests(domain, { client, cache, log: (m) => report('contests', m) });
  const yearsAvailable = availableYears(all);
  const { contests, byTitle } = selectContests(all, years, { titleFallback });
  report('contests', `选中 ${contests.length} 场比赛`, { yearsAvailable, selected: contests.length, byTitle: byTitle.map((c) => c.title) });
  if (!contests.length) throw new Error('所选年份范围内没有比赛');

  /* 3. 成绩表 */
  report('boards', '正在抓取成绩表…', { current: 0, total: contests.length });
  let done = 0;
  const boards = await pMap(
    contests,
    async (c) => {
      const sb = await getScoreboard(domain, c.tid, { client, cache });
      done++;
      report('boards', `成绩表 ${done}/${contests.length}`, { current: done, total: contests.length });
      return [c.tid, sb];
    },
    concurrency
  );
  const scoreboards = new Map(boards);
  const usable = [...scoreboards.values()].filter((s) => s.rows.length).length;
  const unusable = contests.length - usable;
  report('boards', `成绩表抓取完成（${usable}/${contests.length} 场可用）`, { current: contests.length, total: contests.length });
  if (unusable) {
    report(
      'boards',
      `注意：${unusable} 场成绩表拿不到（通常是被限流或比赛尚未结束），已从统计中排除`
    );
  }

  /* 4. 逐用户分析 */
  report('analyze', '正在统计…', { current: 0, total: uids.length });
  const results = [];
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    let uname = '';
    for (const [, sb] of scoreboards) {
      const r = sb.rows.find((x) => x.uid === uid);
      if (r && r.uname) { uname = r.uname; break; }
    }
    if (!uname) {
      try { uname = (await getUser(domain, uid, { client, cache })).uname || `UID ${uid}`; }
      catch { uname = `UID ${uid}`; }
    }
    const res = analyze({ uid, uname, domain, contests, scoreboards });
    results.push(res);
    report('analyze', `已分析 ${uname}`, { current: i + 1, total: uids.length });
  }

  /* 5. 落盘 */
  report('files', '正在生成报告文件…');
  fs.mkdirSync(outDir, { recursive: true });
  const tag = years === 'all' ? 'all' : String(Array.isArray(years) ? years.join('-') : years).replace(/,/g, '_');
  const files = [];

  const writeUserFiles = (res) => {
    const base = `${safeName(res.overview.uname)}-${res.overview.uid}`;
    const md = path.join(outDir, `${base}-成绩分析-${tag}.md`);
    fs.writeFileSync(md, renderMarkdown(res), 'utf8');
    files.push({ name: path.basename(md), kind: 'markdown', user: res.overview.uname });

    const detail = path.join(outDir, `${base}-逐场明细-${tag}.csv`);
    fs.writeFileSync(
      detail,
      toCsv(
        [...res.entries].sort((a, b) => a.begin - b.begin).map((e) => ({
          日期: fmtDate(e.begin), 年份: e.year, 比赛名称: e.title, 比赛ID: e.tid,
          得分: e.score, 排名: e.rank ?? '', 参赛人数: e.fieldSize,
          全场平均分: e.fieldAvg, 全场中位数: e.fieldMed, 全场最高分: e.fieldMax,
          与均分差: e.delta, 击败率百分比: e.beatRate ?? '',
        }))
      ),
      'utf8'
    );
    files.push({ name: path.basename(detail), kind: 'csv', user: res.overview.uname });

    const prob = path.join(outDir, `${base}-每题得分-${tag}.csv`);
    fs.writeFileSync(
      prob,
      toCsv(
        res.entries.map((e) => ({
          日期: fmtDate(e.begin), 比赛名称: e.title,
          ...Object.fromEntries(e.problems.map((v, i) => [e.problemsMeta[i]?.label || `T${i + 1}`, v ?? ''])),
          总分: e.score,
        }))
      ),
      'utf8'
    );
    files.push({ name: path.basename(prob), kind: 'csv', user: res.overview.uname });
  };

  for (const res of results) writeUserFiles(res);

  /* 6. 多人对比 */
  let combinedMd = '';
  if (results.length > 1) {
    combinedMd = renderCombined({ domain, years, tag, contests, scoreboards, results });
    const p = path.join(outDir, `${domain}-${tag}-成绩对比报告.md`);
    fs.writeFileSync(p, combinedMd, 'utf8');
    files.push({ name: path.basename(p), kind: 'markdown', user: '（全部）' });

    const wide = [...contests].sort((a, b) => a.begin - b.begin).map((c) => {
      const row = { 日期: fmtDate(c.begin), 比赛名称: c.title, 比赛ID: c.tid, 参赛人数: scoreboards.get(c.tid)?.rows.length ?? 0 };
      for (const r of results) {
        const e = r.entries.find((x) => x.tid === c.tid);
        row[`${r.overview.uname}_分数`] = e ? e.score : '';
        row[`${r.overview.uname}_排名`] = e ? (e.rank ?? '') : '';
      }
      return row;
    });
    const pw = path.join(outDir, `${domain}-${tag}-成绩对照表.csv`);
    fs.writeFileSync(pw, toCsv(wide), 'utf8');
    files.push({ name: path.basename(pw), kind: 'csv', user: '（全部）' });
  }

  const summary = results.map((r) => {
    const o2 = r.overview;
    return {
      用户: o2.uname, UID: o2.uid,
      比赛总数: o2.contestsTotal, 参赛场次: o2.attended, 参赛率: o2.participationRate + '%',
      总分: o2.total, 平均分: o2.average, 中位数: o2.median, 标准差: o2.stdev,
      最高分: o2.max, 最低分: o2.min, 平均排名: o2.rankAvg ?? '',
      最好排名: o2.rankBest ?? '', 平均击败率: o2.beatAvg ?? '',
    };
  });
  const ps = path.join(outDir, `${domain}-${tag}-成绩汇总.csv`);
  fs.writeFileSync(ps, toCsv(summary), 'utf8');
  files.push({ name: path.basename(ps), kind: 'csv', user: '（全部）' });

  report('done', '完成');

  return {
    domain,
    years,
    tag,
    outDir,
    results,
    files,
    meta: {
      contestsTotal: contests.length,
      contestsWithBoard: usable,
      yearsAvailable,
      byTitle: byTitle.map((c) => c.title),
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 把分析结果压成可以序列化、可以直接喂给前端的形状。
 * 服务端接口和「导出静态数据」工具都用它，保证两边结构一致。
 */
export function toPublicResult(result, id = '') {
  if (!result) return null;
  return {
    id,
    domain: result.domain,
    years: result.years,
    tag: result.tag,
    meta: result.meta,
    files: result.files || [],
    users: result.results.map((r) => ({
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

/* --------------------------- 多人对比 Markdown --------------------------- */

function renderCombined({ domain, years, tag, contests, scoreboards, results }) {
  const md = [];
  md.push(`# ${domain} 域 ${years === 'all' ? '全部年份' : tag} 比赛成绩对比`);
  md.push('');
  md.push(`- 数据来源：https://oj.33dai.cn/d/${domain}/contest`);
  md.push(`- 抓取时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  md.push(`- 比赛总数：${contests.length} 场`);
  md.push('');

  md.push('## 一、总览对比');
  md.push('');
  md.push('| 用户 | UID | 参赛场次 | 参赛率 | 总分 | **平均分** | 中位数 | 标准差 | 最高分 | 最好排名 | 平均击败率 |');
  md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const o = r.overview;
    md.push(
      `| ${o.uname} | ${o.uid} | ${o.attended} | ${o.participationRate}% | ${o.total} | **${o.average}** | ${o.median} | ${o.stdev} | ${o.max} | ${
        o.rankBest ? '#' + o.rankBest : '-'
      } | ${o.beatAvg ?? '-'}% |`
    );
  }
  md.push('');

  const multiYear = results.some((r) => r.byYear && r.byYear.length > 1);
  if (multiYear) {
    md.push('## 二、分年份 × 分用户 平均分');
    md.push('');
    const yearsSet = [...new Set(results.flatMap((r) => (r.byYear || []).map((y) => y.year)))].sort((a, b) => a - b);
    md.push(`| 年份 | ${results.map((r) => r.overview.uname).join(' | ')} |`);
    md.push(`|---|${results.map(() => '---:').join('|')}|`);
    for (const y of yearsSet) {
      const cells = results.map((r) => {
        const b = (r.byYear || []).find((x) => x.year === y);
        if (!b) return '-';
        return b.average === null ? `未参加（共 ${b.contestsTotal} 场）` : `${b.average}（${b.attended} 场）`;
      });
      md.push(`| ${y} | ${cells.join(' | ')} |`);
    }
    md.push('');
    md.push('> 括号内为该年份的参赛场次。');
    md.push('');
  }

  md.push('## 三、逐场对照');
  md.push('');
  md.push(`| 日期 | 比赛 | 参赛人数 | ${results.map((r) => r.overview.uname).join(' | ')} |`);
  md.push(`|---|---|---:|${results.map(() => '---').join('|')}|`);
  for (const c of [...contests].sort((a, b) => a.begin - b.begin)) {
    const cells = results.map((r) => {
      const e = r.entries.find((x) => x.tid === c.tid);
      return e ? `${e.score} / #${e.rank ?? '-'}` : '未参加';
    });
    md.push(`| ${fmtDate(c.begin)}${c.dateSuspect ? ' ⚠' : ''} | ${c.title} | ${scoreboards.get(c.tid)?.rows.length ?? 0} | ${cells.join(' | ')} |`);
  }
  md.push('');
  return md.join('\n');
}
