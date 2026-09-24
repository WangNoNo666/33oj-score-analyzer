#!/usr/bin/env node
/**
 * oj-multi.mjs — 多用户成绩对比（命令行版）
 *
 * 用法:
 *   node oj-multi.mjs <uid1> <uid2> [uid3 ...] [选项]
 *
 * 选项:
 *   --domain <名>        数据域，默认 TYOI
 *   --years <年[,...]>   2026 / 2024,2025 / 2024-2026 / all   默认全部
 *   --out <目录>         输出目录，默认 ./out/multi-<uids>
 *   --concurrency <n>    并发数，默认 5
 *   --no-cache           忽略磁盘缓存
 *   --no-title-year      不按标题兜底归属年份
 *
 * 例:
 *   node oj-multi.mjs 968 1020 1041 --years 2026
 *   node oj-multi.mjs 968 1020 1041 --years 2024-2026 --out "../对比报告"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAnalysis } from './lib/job.mjs';
import { parseYears } from './lib/years.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const opts = { domain: 'TYOI', years: 'all', out: null, concurrency: 5, cache: true, titleYear: true };
const uids = [];
try {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--domain') opts.domain = argv[++i];
    else if (a === '--years' || a === '--year') opts.years = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 5);
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--no-title-year') opts.titleYear = false;
    else if (/^\d+$/.test(a)) uids.push(Number(a));
    else if (a.startsWith('--')) throw new Error(`未知选项: ${a}`);
  }
  opts.years = parseYears(opts.years);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (opts.help || uids.length < 2) {
  console.log(
    [
      '33OJ 多用户成绩对比',
      '',
      '  node oj-multi.mjs <uid1> <uid2> [uid3 ...] [选项]',
      '',
      '选项',
      '  --domain <名>        数据域，默认 TYOI',
      '  --years <年[,...]>   2026 / 2024,2025 / 2024-2026 / all   默认 all',
      '  --out <目录>         输出目录',
      '  --concurrency <n>    并发数，默认 5',
      '  --no-cache           忽略磁盘缓存',
      '',
      '示例',
      '  node oj-multi.mjs 968 1020 1041 --years 2026',
    ].join('\n')
  );
  process.exit(opts.help ? 0 : 1);
}

const outDir = path.resolve(opts.out || path.join(HERE, 'out', `multi-${uids.join('-')}`));

try {
  let last = '';
  const res = await runAnalysis({
    domain: opts.domain,
    uids,
    years: opts.years,
    concurrency: opts.concurrency,
    cacheDir: path.join(HERE, '.cache', 'data'),
    cookieCacheFile: path.join(HERE, '.cache', 'cookie.json'),
    outDir,
    titleFallback: opts.titleYear,
    useCache: opts.cache,
    onProgress: (e) => {
      const line = `${e.stage} | ${e.message}`;
      if (e.stage === 'boards') {
        process.stdout.write(`\r  ${e.message}      `);
        return;
      }
      if (line === last) return;
      last = line;
      process.stdout.write('\n· ' + e.message + '\n');
    },
  });

  const tag = res.tag;
  console.log('\n' + '='.repeat(74));
  console.log(` ${res.domain}  ${opts.years === 'all' ? '全部年份' : tag}   共 ${res.meta.contestsTotal} 场比赛`);
  console.log('='.repeat(74));
  console.log(' ' + '用户'.padEnd(16) + '参赛'.padStart(6) + '总分'.padStart(9) + '平均分'.padStart(11) + '最高'.padStart(7) + '最好名次'.padStart(10));
  for (const r of res.results) {
    const o = r.overview;
    console.log(
      ' ' + o.uname.padEnd(15) + String(o.attended).padStart(6) + String(o.total).padStart(9) +
        String(o.average).padStart(11) + String(o.max).padStart(7) + String(o.rankBest ? '#' + o.rankBest : '-').padStart(10)
    );
  }
  console.log('='.repeat(74));
  console.log('\n输出文件:');
  for (const f of res.files) console.log('  ' + path.join(res.outDir, f.name));
} catch (e) {
  console.error(`\n✗ ${e && e.message ? e.message : e}`);
  process.exit(1);
}
