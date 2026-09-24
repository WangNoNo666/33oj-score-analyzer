/**
 * 纯函数自测 —— 不需要网络、不需要登录，可在 CI 里跑。
 *   node test/selftest.mjs
 */
import assert from 'node:assert/strict';

import { parseContestList, parseScoreboard, decodeEntities, stripTags } from '../lib/scrape.mjs';
import { parseYears, selectContests, availableYears, dateYear } from '../lib/years.mjs';
import { analyze, renderMarkdown } from '../lib/analyze.mjs';
import { looksLikeCookie } from '../lib/auth.mjs';

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

/* ------------------------------ HTML 夹具 ------------------------------ */

const T = {
  a: 1767225600, // 2026-01-01
  b: 1769904000, // 2026-02-01
  c: 2106000000, // 2036-09-26（标题写着 2026 的录入错误）
  d: 1746057600, // 2025-05-01
};

const contestListHtml = `
<table>
<tbody class="oi33-contest-table__group">
<tr><td class="oi33-contest-table__title"><a href="/d/TYOI/contest/aaaaaaaaaaaaaaaaaaaaaaaa">2026模拟赛A</a> <span class="icon icon-star" title="Rated"></span></td></tr>
<tr><td class="oi33-contest-table__meta"><span class="time" data-timestamp="${T.a}">2026-1-1</span> ~ <span class="time" data-timestamp="${T.a + 86400}">2026-1-2</span></td></tr>
</tbody>
<tbody class="oi33-contest-table__group">
<tr><td class="oi33-contest-table__title"><a href="/d/TYOI/contest/bbbbbbbbbbbbbbbbbbbbbbbb">2026模拟赛B</a></td></tr>
<tr><td class="oi33-contest-table__meta"><span data-timestamp="${T.b}">2026-2-1</span> ~ <span data-timestamp="${T.b + 86400}">2026-2-2</span></td></tr>
</tbody>
<tbody class="oi33-contest-table__group">
<tr><td class="oi33-contest-table__title"><a href="/d/TYOI/contest/cccccccccccccccccccccccc">2026下半学期模拟赛</a></td></tr>
<tr><td class="oi33-contest-table__meta"><span data-timestamp="${T.c}">2036-9-26</span> ~ <span data-timestamp="${T.c + 14400}">2036-9-26</span></td></tr>
</tbody>
<tbody class="oi33-contest-table__group">
<tr><td class="oi33-contest-table__title"><a href="/d/TYOI/contest/dddddddddddddddddddddddd">2025模拟赛</a></td></tr>
<tr><td class="oi33-contest-table__meta"><span data-timestamp="${T.d}">2025-5-1</span> ~ <span data-timestamp="${T.d + 86400}">2025-5-2</span></td></tr>
</tbody>
</table>`;

function scoreboardHtml(rows, probs = ['A', 'B']) {
  return `<table class="data-table">
<thead><tr><th class="col--rank">#</th><th class="col--user">用户</th><th class="col--total_score">总分数</th>
${probs.map((p) => `<th class="col--problem"><a href="/x" data-tooltip="${p}题名"> ${p}<br />1/1 </a></th>`).join('')}</tr></thead>
<tbody>${rows
    .map(
      (r) => `<tr>
<td class="col--rank"><span class="rank--normal">${r.rank}</span></td>
<td class="col--user"><button class="star user--${r.uid}" data-uid="${r.uid}"><span class="icon icon-star--outline"></span></button>
<span class="user-profile-link"><a class="user-profile-name uname--lv0" href="/d/TYOI/user/${r.uid}">${r.name}</a></span></td>
<td class="col--total_score"><span>${r.total}</span></td>
${r.p.map((v) => `<td class="col--problem">${v === null ? '<span>-</span>' : `<span>${v}</span>`}</td>`).join('')}
</tr>`
    )
    .join('')}</tbody></table>`;
}

/* ------------------------------ 解析 ------------------------------ */

console.log('\n解析');

t('decodeEntities / stripTags', () => {
  assert.equal(decodeEntities('&amp;&lt;&#65;&#x42;&nbsp;'), '&<AB ');
  assert.equal(stripTags('<b>hi</b>  <i>there</i>'), 'hi there');
});

t('parseContestList 解析出 4 场比赛', () => {
  const rows = parseContestList(contestListHtml, 'TYOI');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].tid, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(rows[0].title, '2026模拟赛A');
  assert.equal(rows[0].begin, T.a);
  assert.equal(rows[0].rated, true);
  assert.equal(rows[1].rated, false);
  assert.equal(rows[3].title, '2025模拟赛');
});

t('parseScoreboard 解析排名 / 总分 / 每题得分', () => {
  const html = scoreboardHtml([
    { uid: 1, name: 'u1', rank: 1, total: 100, p: [100, 0] },
    { uid: 2, name: 'u2', rank: 2, total: 50, p: [50, null] },
  ]);
  const sb = parseScoreboard(html);
  assert.equal(sb.problems.length, 2);
  assert.equal(sb.problems[0].label, 'A');
  assert.equal(sb.problems[0].title, 'A题名');
  assert.equal(sb.rows.length, 2);
  assert.deepEqual(sb.rows[0], { uid: 1, uname: 'u1', rank: '1', total: 100, problems: [100, 0] });
  assert.deepEqual(sb.rows[1].problems, [50, null]);
  assert.equal(sb.maxPage, 1);
});

/* ------------------------------ 年份 ------------------------------ */

console.log('\n年份');

t('parseYears 各种写法', () => {
  assert.deepEqual(parseYears('2026'), [2026]);
  assert.deepEqual(parseYears('2024,2025,2026'), [2024, 2025, 2026]);
  assert.deepEqual(parseYears('2024-2026'), [2024, 2025, 2026]);
  assert.deepEqual(parseYears('2024~2026'), [2024, 2025, 2026]);
  assert.deepEqual(parseYears([2026, 2024, 2026]), [2024, 2026]);
  assert.equal(parseYears('all'), 'all');
  assert.equal(parseYears(''), 'all');
  assert.equal(parseYears(null), 'all');
  assert.throws(() => parseYears('abc'));
});

t('availableYears 统计场次', () => {
  const all = parseContestList(contestListHtml, 'TYOI').map((c) => ({ ...c, year: dateYear(c) }));
  const ys = availableYears(all);
  const map = Object.fromEntries(ys.map((x) => [x.year, x.count]));
  assert.equal(map[2026], 2);
  assert.equal(map[2036], 1);
  assert.equal(map[2025], 1);
  assert.deepEqual(ys.map((x) => x.year), [2036, 2026, 2025]);
});

t('selectContests：按日期归属', () => {
  const all = parseContestList(contestListHtml, 'TYOI');
  const r = selectContests(all, [2026]);
  assert.equal(r.contests.length, 3); // A、B 按日期 + C 按标题兜底
  assert.deepEqual(r.contests.map((c) => c.year), [2026, 2026, 2026]);
  assert.equal(r.byTitle.length, 1);
  assert.equal(r.byTitle[0].title, '2026下半学期模拟赛');
  assert.equal(r.byTitle[0].dateSuspect, true);
});

t('selectContests：关闭标题兜底', () => {
  const all = parseContestList(contestListHtml, 'TYOI');
  const r = selectContests(all, [2026], { titleFallback: false });
  assert.equal(r.contests.length, 2);
  assert.equal(r.byTitle.length, 0);
});

t('selectContests：多年份', () => {
  const all = parseContestList(contestListHtml, 'TYOI');
  const r = selectContests(all, [2025, 2026]);
  assert.equal(r.contests.length, 4);
});

t('selectContests：all 保留全部且不打标签', () => {
  const all = parseContestList(contestListHtml, 'TYOI');
  const r = selectContests(all, 'all');
  assert.equal(r.contests.length, 4);
  assert.equal(r.byTitle.length, 0);
  assert.equal(r.years, 'all');
});

/* ------------------------------ 统计 ------------------------------ */

console.log('\n统计');

function buildScenario() {
  const all = parseContestList(contestListHtml, 'TYOI');
  const { contests } = selectContests(all, [2025, 2026]);
  const byTid = Object.fromEntries(all.map((c) => [c.tid, c]));
  // 走真实解析路径，题目元数据（A/B 标签）也一并带上
  const mk = (rows, probs) => ({ status: 200, note: '', ...parseScoreboard(scoreboardHtml(rows, probs)) });
  const sb = new Map([
    [byTid.aaaaaaaaaaaaaaaaaaaaaaaa.tid, mk([
      { uid: 1, name: 'u1', rank: 1, total: 100, p: [100, 0] },
      { uid: 2, name: 'u2', rank: 2, total: 50, p: [50, 0] },
      { uid: 3, name: 'u3', rank: 3, total: 0, p: [0, 0] },
    ], ['A', 'B'])],
    [byTid.bbbbbbbbbbbbbbbbbbbbbbbb.tid, mk([
      { uid: 1, name: 'u1', rank: 1, total: 200, p: [100, 100] },
      { uid: 2, name: 'u2', rank: 2, total: 100, p: [50, 50] },
    ], ['A', 'B'])],
    [byTid.cccccccccccccccccccccccc.tid, mk([
      { uid: 2, name: 'u2', rank: 1, total: 10, p: [10, 0] },
      { uid: 1, name: 'u1', rank: 2, total: 0, p: [0, 0] },
    ], ['A', 'B'])],
    [byTid.dddddddddddddddddddddddd.tid, mk([
      { uid: 1, name: 'u1', rank: 1, total: 50, p: [50, 0] },
      { uid: 2, name: 'u2', rank: 2, total: 40, p: [40, 0] },
    ], ['A', 'B'])],
  ]);
  return { contests, sb, all };
}

t('analyze 总览指标', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 1, uname: 'u1', domain: 'TYOI', contests, scoreboards: sb });
  const o = r.overview;
  assert.equal(o.attended, 4);
  assert.equal(o.total, 350);
  assert.equal(o.average, 87.5);
  assert.equal(o.median, 75);          // [0,50,100,200] → (50+100)/2
  assert.equal(o.max, 200);
  assert.equal(o.min, 0);
  assert.equal(o.zeroCount, 1);
  assert.equal(o.rankAvg, 1.25);       // (1+1+2+1)/4
  assert.equal(o.rankBest, 1);
  assert.equal(o.rankWorst, 2);
  assert.equal(o.beatAvg, 87.5);       // (100+100+50+100)/4
  assert.equal(o.avgDelta, 25);        // (5+50+50-5)/4
  assert.equal(o.stdev, 73.95);        // [100,200,0,50]
});

t('analyze 分年份统计（时间戳可疑的场次仍计入）', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 1, uname: 'u1', domain: 'TYOI', contests, scoreboards: sb });
  const y26 = r.byYear.find((x) => x.year === 2026);
  const y25 = r.byYear.find((x) => x.year === 2025);
  assert.equal(y26.contestsTotal, 3);
  assert.equal(y26.attended, 3);
  assert.equal(y26.total, 300);
  assert.equal(y26.average, 100);
  assert.equal(y26.dateSuspect, true);
  assert.equal(y25.contestsTotal, 1);
  assert.equal(y25.average, 50);
});

t('analyze 未参加与不可用的场次分开归类', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 99, uname: 'nobody', domain: 'TYOI', contests, scoreboards: sb });
  assert.equal(r.entries.length, 0);
  assert.equal(r.missed.length, 4);
  assert.equal(r.overview.average, 0);
});

t('analyze 某年未参加时平均分为 null（而不是 0）', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 2, uname: 'u2', domain: 'TYOI', contests, scoreboards: sb });
  assert.equal(r.byYear.find((x) => x.year === 2025).average, 40);
  const c = contests.filter((x) => x.year === 2025);
  const r2 = analyze({ uid: 3, uname: 'u3', domain: 'TYOI', contests: c, scoreboards: sb });
  assert.equal(r2.byYear[0].average, null);
});

t('analyze 题位统计', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 1, uname: 'u1', domain: 'TYOI', contests, scoreboards: sb });
  assert.equal(r.byIndex.length, 2);
  assert.equal(r.byIndex[0].label, 'A');
  assert.equal(r.byIndex[0].n, 4);
  assert.equal(r.byIndex[0].userAvg, 62.5);   // (100+100+0+50)/4
  assert.equal(r.byIndex[1].userAvg, 25);     // (0+100+0+0)/4
});

t('renderMarkdown 产出合理报告', () => {
  const { contests, sb } = buildScenario();
  const r = analyze({ uid: 1, uname: 'u1', domain: 'TYOI', contests, scoreboards: sb });
  const md = renderMarkdown(r);
  assert.ok(md.includes('# u1（UID 1） 成绩分析'));
  assert.ok(md.includes('平均分（按参赛场次）'));
  assert.ok(md.includes('87.5'));
  assert.ok(md.includes('分年份统计'));
  assert.ok(md.includes('各题位表现'));
  assert.ok(md.includes('逐场明细'));
  assert.ok(md.includes('⚠'));
});

/* ------------------------------ 杂项 ------------------------------ */

console.log('\n杂项');

t('looksLikeCookie 基本形状检查', () => {
  assert.equal(looksLikeCookie('sid=abc; sid.sig=def'), true);
  assert.equal(looksLikeCookie(''), false);
  assert.equal(looksLikeCookie('abc'), false);
  assert.equal(looksLikeCookie('x'.repeat(5000) + '='), false);
});

console.log(`\n${n} 项通过`);
