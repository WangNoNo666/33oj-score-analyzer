#!/usr/bin/env node
/**
 * start-edge.mjs — 启动一个带调试端口的 Edge，使用独立配置文件。
 *
 * 用法: node start-edge.mjs [--port 9222] [--domain TYOI] [--profile <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const port = Number(process.env.OJ_CDP_PORT || arg('--port', 9222));
const domain = arg('--domain', 'TYOI');
const profile = path.resolve(arg('--profile', path.join(HERE, '..', '.edge-oj')));

const EDGE_CANDIDATES = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
];
const exe = EDGE_CANDIDATES.find((f) => f && fs.existsSync(f));

console.log('');
console.log('  ┌────────────────────────────────────────────────┐');
console.log('  │  33OJ 成绩分析器 · 启动 Edge（登录用）        │');
console.log('  └────────────────────────────────────────────────┘');
console.log('');

if (!exe) {
  console.error('  ✗ 找不到 msedge.exe，请确认已安装 Microsoft Edge。');
  process.exit(1);
}

// 已经有实例在跑就不再重复启动
let already = false;
try {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  already = r.ok;
} catch {}

if (already) {
  console.log(`  · 端口 ${port} 上已有一个带调试功能的 Edge 在运行，直接复用。`);
} else {
  fs.mkdirSync(profile, { recursive: true });
  console.log('  Edge      : ' + exe);
  console.log('  配置文件  : ' + profile);
  console.log('  调试端口  : ' + port);
  console.log('');
  spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      `https://oj.33dai.cn/d/${domain}/login`,
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();
  await new Promise((r) => setTimeout(r, 2500));
  console.log('  ✓ 已启动。');
}

console.log('');
console.log('  接下来：');
console.log('    1. 在弹出的 Edge 窗口里登录 oj.33dai.cn（只需一次）；');
console.log('    2. 保持这个窗口开着，不要关闭；');
console.log('    3. 回到分析器界面，点「重新检测」即可开始抓取。');
console.log('');
console.log('  注意：这个 Edge 使用独立配置文件，和你日常用的 Edge 互不干扰。');
console.log('');
