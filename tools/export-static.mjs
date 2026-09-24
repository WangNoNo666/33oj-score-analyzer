#!/usr/bin/env node
/**
 * tools/export-static.mjs — 把分析结果导出成静态数据，供纯静态站点使用
 *
 * 这样 GitHub Pages 上的网站不依赖任何后端：打开就能看数据、画图、下载。
 * 代价是数据是「快照」——想更新就重新跑一次本脚本并推送。
 *
 * 用法:
 *   node tools/export-static.mjs                       # 默认导出三人的 2026 与全部年份
 *   node tools/export-static.mjs --uids 968,1020 --years 2026
 *   node tools/export-static.mjs --domain TYOI --years 2024-2026
 *
 * 需要本机有已登录的 Edge（和平时抓取一样）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryCache } from '../lib/scrape.mjs';
import { runAnalysis, toPublicResult } from '../lib/job.mjs';
import { parseYears } from '../lib/years.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 放在界面目录里：本地由后端托管时是 /data/，Pages 上是 /app/data/，
// 前端用相对路径 ./data/ 两边都能取到。
const OUT_DIR = path.join(ROOT, 'app', 'ui', 'data');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const domain = arg('--domain', 'TYOI');
const uids = String(arg('--uids', '968,1020,1041'))
  .split(/[,，\s]+/)
  .map(Number)
  .filter((x) => Number.isInteger(x) && x > 0);
const yearSpecs = String(arg('--years', '2026|all')).split('|').map((s) => s.trim());
const refresh = argv.includes('--no-cache');

const label = (ys) => (ys === 'all' ? '全部年份' : String(ys).replace(/,/g, ','));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];

  for (const spec of yearSpecs) {
    const years = parseYears(spec);
    const tag = years === 'all' ? 'all' : years.join('-');
    const id = `${domain.toLowerCase()}-${tag}`;

    console.log(`\n▶ 导出 ${domain} / ${label(spec)} -> ${id}.json`);
    const t0 = Date.now();
    const result = await runAnalysis({
      domain,
      uids,
      years,
      concurrency: 5,
      cache: new MemoryCache(15 * 60 * 1000, 4000),
      outDir: path.join(ROOT, '.cache', 'export-tmp', id),
      allowEdge: true,
      useCache: !refresh,
      onProgress: (e) => {
        if (e.stage === 'boards') process.stdout.write(`\r  抓取成绩表 ${e.current}/${e.total}   `);
      },
    });
    process.stdout.write('\r');

    const pub = toPublicResult(result, id);
    // 静态站不需要文件下载（没有后端），但保留字段以免前端报错
    pub.files = [];
    pub.offline = true;
    pub.generatedAt = new Date().toISOString();

    const file = path.join(OUT_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(pub), 'utf8');
    const kb = (fs.statSync(file).size / 1024).toFixed(0);

    const users = pub.users.map((u) => u.overview);
    console.log(
      `  ✓ ${file.replace(ROOT + path.sep, '')}  ${kb} KB  ` +
        `${result.meta.contestsTotal} 场比赛 / ${result.meta.contestsWithBoard} 场有成绩表  ` +
        `(${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
    for (const u of users) {
      console.log(`     ${u.uname.padEnd(14)} 参赛 ${String(u.attended).padStart(3)}  平均分 ${u.average}`);
    }

    manifest.push({
      id,
      file: `${id}.json`,
      domain,
      years: pub.years,
      label: `${domain} · ${label(spec)}`,
      contests: result.meta.contestsTotal,
      users: users.map((u) => ({ uid: u.uid, uname: u.uname, average: u.average, attended: u.attended })),
    });

    fs.rmSync(path.join(ROOT, '.cache', 'export-tmp'), { recursive: true, force: true });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), domain, datasets: manifest }, null, 1),
    'utf8'
  );

  console.log('\n  ────────────────────────────────────────────');
  console.log(`  共导出 ${manifest.length} 份数据集 -> site/data/`);
  console.log('  提交并推送后，Pages 站点就能直接展示这些数据（不需要任何后端）。');
  console.log('  ────────────────────────────────────────────\n');
}

main().catch((e) => {
  console.error(`\n  ✗ ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
