#!/usr/bin/env node
/**
 * make-shortcut.mjs — 创建「33OJ 成绩分析器」快捷方式（默认放桌面）。
 *
 * 用法: node make-shortcut.mjs [--dir <目录>] [--name <文件名>]
 *
 * PowerShell 读取含中文的脚本需要 UTF-8 BOM，所以这里先把 .ps1 写到临时文件再执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(HERE, '启动-OJ成绩分析器.cmd');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const desktop = path.resolve(arg('--dir', path.join(os.homedir(), 'Desktop')));
const link = path.join(desktop, arg('--name', '33OJ 成绩分析器') + '.lnk');

console.log('');
if (!fs.existsSync(target)) {
  console.error('  ✗ 找不到启动器: ' + target);
  process.exit(1);
}
if (!fs.existsSync(desktop)) {
  console.error('  ✗ 找不到目标目录: ' + desktop);
  process.exit(1);
}

// PowerShell 用反引号转义，反斜杠无需转义；单引号字符串里只需把 ' 变成 ''
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const ps = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut(${psq(link)})
$sc.TargetPath = ${psq(target)}
$sc.WorkingDirectory = ${psq(HERE)}
$sc.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,137"
$sc.Description = '33OJ 用户成绩抓取与分析'
$sc.Save()
`;

const tmp = path.join(os.tmpdir(), `oj-shortcut-${Date.now()}.ps1`);
fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');

const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
  encoding: 'utf8',
  stdio: 'inherit',
});
try { fs.unlinkSync(tmp); } catch {}

console.log('');
if (fs.existsSync(link)) {
  console.log('  ✓ 已创建桌面快捷方式：');
  console.log('    ' + link);
  console.log('');
  console.log('  双击它即可打开分析器。');
} else {
  console.error('  ✗ 创建失败（退出码 ' + r.status + '）。');
  console.error('    可以手动把「启动-OJ成绩分析器.cmd」发送到桌面。');
  process.exit(1);
}
