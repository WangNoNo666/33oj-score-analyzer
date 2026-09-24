/**
 * analyze.mjs — 成绩统计与报告生成
 */
import { fmtDate, monthKey } from './scrape.mjs';

const num = (v) => (Number.isFinite(v) ? v : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const r2 = (x) => Math.round(x * 100) / 100;
const parseRank = (s) => {
  const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} p
 * @param {number} p.uid
 * @param {string} p.uname
 * @param {string} p.domain
 * @param {Array}  p.contests   已按时间升序、已按年份筛选的比赛
 * @param {Map}    p.scoreboards tid -> { status, note, problems, rows }
 */
export function analyze({ uid, uname, domain, contests, scoreboards, year }) {
  const entries = [];
  const unavailable = [];
  const missed = [];

  for (const c of contests) {
    const sb = scoreboards.get(c.tid) || { status: 0, note: 'missing', rows: [], problems: [] };
    if (!sb.rows.length) {
      unavailable.push({ ...c, note: sb.note || `http-${sb.status}` });
      continue;
    }
    const row = sb.rows.find((r) => r.uid === uid);
    const fieldTotals = sb.rows.map((r) => num(r.total));
    const fieldSize = sb.rows.length;
    const fieldAvg = mean(fieldTotals);
    const fieldMed = median(fieldTotals);
    const fieldMax = fieldTotals.length ? Math.max(...fieldTotals) : 0;

    if (!row) {
      missed.push({ ...c, fieldSize, fieldAvg, fieldMax });
      continue;
    }

    const rank = parseRank(row.rank);
    const score = num(row.total);
    const beatRate = rank ? (fieldSize - rank + 1) / fieldSize : null;

    entries.push({
      tid: c.tid,
      title: c.title,
      begin: c.begin,
      end: c.end,
      rated: c.rated,
      year: c.year ?? new Date(c.begin * 1000).getFullYear(),
      month: monthKey(c.begin),
      score,
      rank,
      rankDisplay: row.rank,
      fieldSize,
      fieldAvg: r2(fieldAvg),
      fieldMed: r2(fieldMed),
      fieldMax,
      delta: r2(score - fieldAvg),
      beatRate: beatRate === null ? null : r2(beatRate * 100),
      problems: row.problems,
      problemsMeta: sb.problems,
      dateSuspect: !!c.dateSuspect,
    });
  }

  // ---------------- 总览 ----------------
  const scores = entries.map((e) => e.score);
  const ranks = entries.filter((e) => e.rank).map((e) => e.rank);
  const beats = entries.filter((e) => e.beatRate !== null).map((e) => e.beatRate);
  const sum = scores.reduce((a, b) => a + b, 0);
  const validContests = contests.filter((c) => (scoreboards.get(c.tid)?.rows.length || 0) > 0);

  const overview = {
    uid,
    uname,
    domain,
    contestsTotal: contests.length,
    contestsWithBoard: validContests.length,
    attended: entries.length,
    missedCount: missed.length,
    unavailableCount: unavailable.length,
    participationRate: contests.length ? r2((entries.length / contests.length) * 100) : 0,
    total: sum,
    average: entries.length ? r2(sum / entries.length) : 0,
    median: r2(median(scores)),
    stdev: r2(stdev(scores)),
    max: scores.length ? Math.max(...scores) : 0,
    min: scores.length ? Math.min(...scores) : 0,
    zeroCount: scores.filter((s) => s === 0).length,
    averageIncludingMissed: contests.length ? r2(sum / contests.length) : 0,
    averageOverBoard: validContests.length ? r2(sum / validContests.length) : 0,
    rankAvg: ranks.length ? r2(mean(ranks)) : null,
    rankBest: ranks.length ? Math.min(...ranks) : null,
    rankWorst: ranks.length ? Math.max(...ranks) : null,
    beatAvg: beats.length ? r2(mean(beats)) : null,
    beatBest: beats.length ? Math.max(...beats) : null,
    // 与全场平均相比的整体表现
    avgDelta: entries.length ? r2(mean(entries.map((e) => e.delta))) : 0,
  };

  // ---------------- 月度趋势（排除时间戳可疑的比赛） ----------------
  const months = new Map();
  for (const e of entries) {
    if (e.dateSuspect) continue;
    if (!months.has(e.month)) months.set(e.month, []);
    months.get(e.month).push(e);
  }
  const monthly = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, list]) => ({
      month,
      n: list.length,
      sum: list.reduce((a, e) => a + e.score, 0),
      avg: r2(mean(list.map((e) => e.score))),
      max: Math.max(...list.map((e) => e.score)),
      rankAvg: r2(mean(list.filter((e) => e.rank).map((e) => e.rank))),
    }));

  // ---------------- 题位分析 ----------------
  const maxIdx = Math.max(0, ...entries.map((e) => e.problems.length));
  const byIndex = [];
  for (let i = 0; i < maxIdx; i++) {
    const rowsForIdx = entries.filter((e) => e.problems.length > i);
    if (!rowsForIdx.length) continue;

    const userVals = rowsForIdx.map((e) => e.problems[i]).filter((v) => v !== null && v !== undefined);
    const fieldVals = [];
    const fieldMaxPerContest = [];
    for (const c of contests) {
      const sb = scoreboards.get(c.tid);
      if (!sb || !sb.rows.length) continue;
      if (!sb.rows.some((r) => r.uid === uid)) continue;
      const vals = sb.rows.map((r) => r.problems[i]).filter((v) => v !== null && v !== undefined);
      if (vals.length) {
        fieldVals.push(...vals);
        fieldMaxPerContest.push(Math.max(...vals));
      }
    }

    const labels = rowsForIdx.map((e) => e.problemsMeta[i]?.label).filter(Boolean);
    const titles = new Set(rowsForIdx.map((e) => e.problemsMeta[i]?.title).filter(Boolean));
    byIndex.push({
      index: i + 1,
      label: labels[0] || `T${i + 1}`,
      distinctTitles: titles.size,
      n: userVals.length,
      userAvg: r2(mean(userVals)),
      userZero: userVals.filter((v) => v === 0).length,
      fieldAvg: r2(mean(fieldVals)),
      fieldMaxAvg: r2(mean(fieldMaxPerContest)),
      relative: fieldVals.length && mean(fieldVals) > 0 ? r2(mean(userVals) / mean(fieldVals)) : null,
      fullMarkRate: fieldMaxPerContest.length && mean(fieldMaxPerContest) > 0
        ? r2((mean(userVals) / mean(fieldMaxPerContest)) * 100)
        : null,
    });
  }

  return {
    overview,
    entries,
    monthly,
    byIndex,
    byYear: computeByYear(contests, entries, scoreboards, uid),
    missed,
    unavailable,
    titleOnly: entries.filter((e) => e.dateSuspect),
  };
}

/** 按年份分组统计。 */
function computeByYear(contests, entries, scoreboards, uid) {
  const years = [...new Set(contests.map((c) => c.year ?? new Date(c.begin * 1000).getFullYear()))].sort((a, b) => b - a);
  return years.map((year) => {
    const cs = contests.filter((c) => (c.year ?? new Date(c.begin * 1000).getFullYear()) === year);
    const es = entries.filter((e) => e.year === year).sort((a, b) => a.begin - b.begin);
    const scores = es.map((e) => e.score);
    const sum = scores.reduce((a, b) => a + b, 0);
    const ranks = es.filter((e) => e.rank).map((e) => e.rank);
    const beats = es.filter((e) => e.beatRate !== null).map((e) => e.beatRate);
    const boardCount = cs.filter((c) => (scoreboards.get(c.tid)?.rows.length || 0) > 0).length;
    return {
      year,
      contestsTotal: cs.length,
      contestsWithBoard: boardCount,
      attended: es.length,
      participationRate: cs.length ? r2((es.length / cs.length) * 100) : 0,
      total: sum,
      average: es.length ? r2(sum / es.length) : null,
      averageIncludingMissed: cs.length ? r2(sum / cs.length) : 0,
      median: es.length ? r2(median(scores)) : null,
      stdev: r2(stdev(scores)),
      max: scores.length ? Math.max(...scores) : 0,
      min: scores.length ? Math.min(...scores) : 0,
      zeroCount: scores.filter((s) => s === 0).length,
      rankAvg: ranks.length ? r2(mean(ranks)) : null,
      rankBest: ranks.length ? Math.min(...ranks) : null,
      beatAvg: beats.length ? r2(mean(beats)) : null,
      avgDelta: es.length ? r2(mean(es.map((e) => e.delta))) : 0,
      dateSuspect: cs.some((c) => c.dateSuspect),
    };
  });
}

/* ------------------------------ 渲染 ------------------------------ */

export function renderMarkdown(res) {
  const o = res.overview;
  const who = o.uname === `UID ${o.uid}` ? o.uname : `${o.uname}（UID ${o.uid}）`;
  const md = [];
  md.push(`# ${who} 成绩分析`);
  md.push('');
  md.push(`- 数据域：\`${o.domain}\`    ·    抓取时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  md.push(`- 统计范围：${o.contestsTotal} 场比赛（其中 ${o.contestsWithBoard} 场成绩表可用）`);
  md.push('');

  let secNo = 0;
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
  const sec = (t) => {
    md.push(`## ${CN[secNo++] || secNo}、${t}`);
    md.push('');
  };

  sec('总览');
  md.push('| 指标 | 数值 |');
  md.push('|---|---:|');
  md.push(`| 参赛场次 | ${o.attended} / ${o.contestsTotal}（参赛率 ${o.participationRate}%） |`);
  md.push(`| 未参加 | ${o.missedCount} 场 |`);
  md.push(`| **平均分（按参赛场次）** | **${o.average}** |`);
  md.push(`| 平均分（全部比赛，未参加计 0） | ${o.averageIncludingMissed} |`);
  md.push(`| 平均分（仅有成绩表的比赛） | ${o.averageOverBoard} |`);
  md.push(`| 总分 | ${o.total} |`);
  md.push(`| 中位数 | ${o.median} |`);
  md.push(`| 标准差 | ${o.stdev} |`);
  md.push(`| 最高分 / 最低分 | ${o.max} / ${o.min} |`);
  md.push(`| 零分场次 | ${o.zeroCount} |`);
  md.push(`| 平均排名 / 最好 / 最差 | ${o.rankAvg ?? '-'} / ${o.rankBest ? '#' + o.rankBest : '-'} / ${o.rankWorst ? '#' + o.rankWorst : '-'} |`);
  md.push(`| 平均击败率 | ${o.beatAvg ?? '-'}% |`);
  md.push(`| 场均比全场平均分 | ${o.avgDelta >= 0 ? '+' : ''}${o.avgDelta} |`);
  md.push('');
  if (res.titleOnly && res.titleOnly.length) {
    md.push(
      `> ⚠ 其中 ${res.titleOnly.length} 场比赛是按标题归入本年度、但时间戳年份不符（OJ 录入错误）：` +
        res.titleOnly.map((e) => `${e.title}（记为 ${new Date(e.begin * 1000).toISOString().slice(0, 10)}）`).join('、') +
        '。它们不参与月度趋势统计。'
    );
    md.push('');
  }

  if (res.byYear && res.byYear.length > 1) {
    sec('分年份统计');
    md.push('| 年份 | 比赛总数 | 参赛场次 | 参赛率 | 总分 | **平均分** | 中位数 | 标准差 | 最高分 | 平均排名 | 最好排名 | 场均高于均分 |');
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const y of res.byYear) {
      md.push(
        `| ${y.year}${y.dateSuspect ? ' ⚠' : ''} | ${y.contestsTotal} | ${y.attended} | ${y.participationRate}% | ${y.total} | **${y.average ?? '-'}** | ${y.median ?? '-'} | ${y.stdev} | ${y.max} | ${
          y.rankAvg ?? '-'
        } | ${y.rankBest ? '#' + y.rankBest : '-'} | ${y.avgDelta >= 0 ? '+' : ''}${y.avgDelta} |`
      );
    }
    md.push('');
    md.push('> 各年份的「平均分」= 该年总分 ÷ 该年实际参赛场次。');
    md.push('');
  }

  if (res.monthly.length) {
    sec('月度趋势');
    md.push('| 月份 | 场次 | 总分 | 平均分 | 最高分 | 平均排名 |');
    md.push('|---|---:|---:|---:|---:|---:|');
    for (const m of res.monthly) {
      md.push(`| ${m.month} | ${m.n} | ${m.sum} | ${m.avg} | ${m.max} | ${Number.isFinite(m.rankAvg) ? m.rankAvg : '-'} |`);
    }
    md.push('');
  }

  if (res.byIndex.length) {
    sec('各题位表现（把所有比赛的 T1/T2/… 对齐统计）');
    md.push('| 题位 | 我参赛场次 | 我的平均得分 | 我的零分次数 | 全场平均 | 全场最高分(均值) | 相对全场 | 相对满分级 |');
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const b of res.byIndex) {
      md.push(
        `| ${b.label} | ${b.n} | ${b.userAvg} | ${b.userZero} | ${b.fieldAvg} | ${b.fieldMaxAvg} | ${
          b.relative === null ? '-' : b.relative.toFixed(2) + '×'
        } | ${b.fullMarkRate === null ? '-' : b.fullMarkRate + '%'} |`
      );
    }
    md.push('');
    md.push(
      '> 「相对全场」= 我的平均得分 ÷ 全场平均得分，>1 说明该题位相对强于整体。' +
        '「相对满分级」以「全场最高分」的均值为满分参考。' +
        '注意各题的标题每场都不同，因此这里只按**题位顺序**对齐，不代表同一道题。'
    );
    md.push('');
  }

  sec('逐场明细');
  md.push('| 日期 | 比赛 | 得分 | 排名 | 参赛人数 | 全场均分 | 与均分差 | 击败率 |');
  md.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const e of [...res.entries].sort((a, b) => b.begin - a.begin)) {
    md.push(
      `| ${fmtDate(e.begin)}${e.dateSuspect ? ' ⚠' : ''} | ${e.title} | ${e.score} | ${e.rank ? '#' + e.rank : '-'} | ${e.fieldSize} | ${e.fieldAvg} | ${
        e.delta >= 0 ? '+' : ''
      }${e.delta} | ${e.beatRate === null ? '-' : e.beatRate + '%'} |`
    );
  }
  md.push('');

  if (res.missed.length) {
    sec('未参加的比赛');
    md.push('| 日期 | 比赛 | 参赛人数 | 全场均分 | 全场最高 |');
    md.push('|---|---|---:|---:|---:|');
    for (const c of [...res.missed].sort((a, b) => b.begin - a.begin)) {
      md.push(`| ${fmtDate(c.begin)} | ${c.title} | ${c.fieldSize} | ${r2(c.fieldAvg)} | ${c.fieldMax} |`);
    }
    md.push('');
  }

  if (res.unavailable.length) {
    sec('成绩表不可用');
    md.push('| 日期 | 比赛 | 状态 |');
    md.push('|---|---|---|');
    for (const c of res.unavailable) md.push(`| ${fmtDate(c.begin)} | ${c.title} | ${c.note} |`);
    md.push('');
  }

  return md.join('\n');
}

export function renderConsole(res) {
  const o = res.overview;
  const L = [];
  const bar = '='.repeat(58);
  const who = o.uname === `UID ${o.uid}` ? o.uname : `${o.uname}  (UID ${o.uid})`;
  L.push(bar);
  L.push(` 成绩分析  ${who}   域: ${o.domain}`);
  L.push(bar);
  L.push(` 比赛总数        ${o.contestsTotal}    (成绩表可用 ${o.contestsWithBoard})`);
  L.push(` 参赛场次        ${o.attended}   (参赛率 ${o.participationRate}%)`);
  L.push(` 平均分 ★        ${o.average}`);
  L.push(` 平均分(含缺席)  ${o.averageIncludingMissed}`);
  L.push(` 总分            ${o.total}`);
  L.push(` 中位数/标准差   ${o.median} / ${o.stdev}`);
  L.push(` 最高/最低       ${o.max} / ${o.min}   零分 ${o.zeroCount} 场`);
  L.push(` 平均排名        ${o.rankAvg ?? '-'}   (最好 #${o.rankBest ?? '-'} / 最差 #${o.rankWorst ?? '-'})`);
  L.push(` 平均击败率      ${o.beatAvg ?? '-'}%`);
  L.push(` 场均高于均分    ${o.avgDelta >= 0 ? '+' : ''}${o.avgDelta}`);
  if (res.byYear && res.byYear.length > 1) {
    L.push('');
    L.push(' 分年份');
    L.push('   年份   场次     总分      平均分');
    for (const y of res.byYear) {
      L.push(`   ${y.year}${y.dateSuspect ? '*' : ' '}  ${String(y.attended).padStart(3)}  ${String(y.total).padStart(8)}  ${String(y.average ?? '-').padStart(9)}`);
    }
  }
  if (res.monthly.length) {
    L.push('');
    L.push(' 月度趋势');
    for (const m of res.monthly) L.push(`   ${m.month}  ${String(m.n).padStart(2)} 场   平均 ${String(m.avg).padStart(6)}`);
  }
  if (res.byIndex.length) {
    L.push('');
    L.push(' 题位相对表现 (相对全场平均)');
    for (const b of res.byIndex) {
      L.push(`   ${String(b.label).padEnd(4)} 我 ${String(b.userAvg).padStart(6)}  全场 ${String(b.fieldAvg).padStart(6)}   ${b.relative === null ? '-' : b.relative.toFixed(2) + '×'}`);
    }
  }
  L.push(bar);
  return L.join('\n');
}
