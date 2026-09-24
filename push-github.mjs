#!/usr/bin/env node
/**
 * push-github.mjs — 一键把本仓库推送到 GitHub，顺带创建远程仓库、开启 Pages。
 *
 * 用法（推荐：把 Token 放在环境变量里，不要写进命令行历史）：
 *
 *   set GITHUB_TOKEN=ghp_xxxxxxxx
 *   node push-github.mjs
 *
 * 或者：
 *   node push-github.mjs ghp_xxxxxxxx [仓库名]
 *
 * Token 需要什么权限？
 *   · 经典 Token：勾选 repo 就够了
 *   · 细粒度 Token：Repository permissions → Contents: Read and write、
 *     Administration: Read and write（创建仓库用）、Pages: Read and write（开启 Pages 用）
 *
 * 这个脚本不会把 Token 写进 .git/config，也不会落盘。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = process.platform === 'win32' ? 'git' : 'git';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || argv[0] || '').trim();
const repoName = (argv[1] || '33oj-score-analyzer').trim();
const branch = 'main';

const say = (...a) => console.log(...a);
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

if (!token) {
  die(
    '没有拿到 GitHub Token。\n\n' +
      '  请先生成一个：https://github.com/settings/tokens\n' +
      '  然后在命令行里执行（Token 不会外泄给任何人）：\n\n' +
      '    set GITHUB_TOKEN=你的Token\n' +
      '    node push-github.mjs\n'
  );
}

/* ------------------------------------------------------------------ */
/* 这台机器上装有会做 TLS 拦截的证书（Node 自带的 CA 不认它），
   所以把 Windows 根证书库导出成 PEM，供 https 与 git 一起使用。        */
/* ------------------------------------------------------------------ */

const CA_FILE = path.join(HERE, '.cache', 'win-ca.pem');
let caCerts = null; // PEM 字符串数组

function splitPem(text) {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []);
}

function ensureCaBundle() {
  if (caCerts) return caCerts;
  if (!fs.existsSync(CA_FILE) || fs.statSync(CA_FILE).size < 100) {
    fs.mkdirSync(path.dirname(CA_FILE), { recursive: true });
    const ps = [
      "$ErrorActionPreference='Stop'",
      '$certs = @()',
      '$certs += Get-ChildItem Cert:\\LocalMachine\\Root -ErrorAction SilentlyContinue',
      '$certs += Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue',
      '$sb = New-Object System.Text.StringBuilder',
      'foreach ($c in $certs) {',
      '  if (-not $c.RawData) { continue }',
      "  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')",
      "  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))",
      "  [void]$sb.AppendLine('-----END CERTIFICATE-----')",
      '}',
      `[System.IO.File]::WriteAllText('${CA_FILE}', $sb.ToString(), [System.Text.Encoding]::ASCII)`,
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `oj-ca-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, ps, 'utf8');
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { stdio: 'ignore' });
    try { fs.unlinkSync(tmp); } catch {}
  }
  try {
    caCerts = splitPem(fs.readFileSync(CA_FILE, 'utf8'));
  } catch {
    caCerts = [];
  }
  return caCerts;
}

/** 用 Node 自带根证书 + 系统根证书一起做校验。 */
function caOption() {
  const sys = ensureCaBundle();
  if (!sys.length) return undefined;
  return [...tls.rootCertificates, ...sys];
}

/** 极简 https JSON 请求（用 node:https 才能自定义 ca）。 */
function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        ca: caOption(),
        timeout: 30000,
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: d }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */

let gitExtra = [];
let caExported = false;

function ensureGitCa() {
  if (caExported) return;
  caExported = true;
  ensureCaBundle();
  if (fs.existsSync(CA_FILE)) {
    gitExtra = ['-c', 'http.sslBackend=openssl', '-c', `http.sslCAInfo=${CA_FILE}`];
  }
}

function git(args, { allowFail = false, quiet = false, input } = {}) {
  const r = spawnSync(GIT, [...gitExtra, ...args], {
    cwd: HERE,
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !allowFail) {
    // schannel 挂了就换 OpenSSL + 系统根证书再来一次
    if (/schannel|SEC_E_|AcquireCredentialsHandle|unable to get local issuer/i.test(out) && !gitExtra.length) {
      ensureGitCa();
      return git(args, { allowFail, quiet });
    }
    die(`git ${args.join(' ')} 失败：\n${out.trim()}`);
  }
  if (!quiet && out.trim() && r.status === 0) say(out.trim());
  return { ok: r.status === 0, out };
}

const api = async (method, url, body) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': '33oj-score-analyzer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let payload;
  if (body) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  let r;
  try {
    r = await httpsRequest(method, 'https://api.github.com' + url, headers, payload);
  } catch (e) {
    die(`连接 GitHub API 失败：${e.message}\n  → 检查网络/代理，或改用能访问 github.com 的网络重试。`);
  }
  let json = null;
  try { json = r.text ? JSON.parse(r.text) : null; } catch {}
  return { status: r.status, json, text: r.text };
};

/* ------------------------------------------------------------------ */

say('\n  33OJ 成绩分析器 · 推送到 GitHub\n');

/* 1. 校验 Token */
const me = await api('GET', '/user');
if (me.status !== 200) die(`Token 无效或权限不足（HTTP ${me.status}）：${me.json?.message || me.text.slice(0, 120)}`);
const login = me.json.login;
say(`  ✓ Token 有效，账号：${login}`);

/* 2. 建仓库（已存在就跳过） */
const full = `${login}/${repoName}`;
let repoUrl = `https://github.com/${full}.git`;
const exists = await api('GET', `/repos/${full}`);
if (exists.status === 200) {
  say(`  · 仓库已存在：${exists.json.html_url}`);
  repoUrl = exists.json.clone_url;
} else if (exists.status === 404) {
  say(`  · 正在创建仓库 ${full} …`);
  const created = await api('POST', '/user/repos', {
    name: repoName,
    description: '抓取并分析 33OJ 用户在任意年份的比赛成绩：平均分、排名、月度趋势、题位表现，支持多年份与多人对比。',
    homepage: `https://${login.toLowerCase()}.github.io/${repoName}/`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  });
  if (created.status !== 201) die(`创建仓库失败（HTTP ${created.status}）：${created.json?.message || created.text.slice(0, 200)}`);
  repoUrl = created.json.clone_url;
  say(`  ✓ 已创建：${created.json.html_url}`);
} else {
  die(`查询仓库失败（HTTP ${exists.status}）：${exists.json?.message || ''}`);
}

/* 3. 确保有提交 */
const hasCommit = git(['rev-parse', '--verify', 'HEAD'], { allowFail: true, quiet: true }).ok;
if (!hasCommit) die('本地还没有任何提交，先 git add -A && git commit -m "init" 再来。');

/* 4. push（凭据只出现在这一次命令里，不写入 .git/config） */
const force = process.argv.includes('--force');
const pushUrl = `https://x-access-token:${token}@github.com/${full}.git`;
say(`  · 正在推送 ${branch} …`);
const pushArgs = ['push', '--quiet', pushUrl, `${branch}:${branch}`];
if (force) pushArgs.push('--force');
const pushed = git(pushArgs, { allowFail: true });
if (!pushed.ok) {
  if (/Repository not found|403|401/i.test(pushed.out)) {
    die(`推送被拒：Token 是否有该仓库的 Contents 写权限？\n${pushed.out.trim()}`);
  }
  if (/rejected|non-fast-forward|fetch first/i.test(pushed.out)) {
    die(
      `远程 ${branch} 分支已有内容，本地不是它的后代。\n` +
        `  确认要覆盖的话，加上 --force 再跑一次：\n` +
        `    node push-github.mjs --force\n\n${pushed.out.trim()}`
    );
  }
  die(`推送失败：\n${pushed.out.trim()}`);
}
say('  ✓ 推送完成');

/* 5. 配好 origin（不带凭据） */
git(['remote', 'remove', 'origin'], { allowFail: true, quiet: true });
git(['remote', 'add', 'origin', repoUrl], { quiet: true });
say(`  · 已设置 origin = ${repoUrl}`);

/* 6. 尝试开启 Pages（失败不影响主流程） */
const pages = await api('PUT', `/repos/${full}/pages`, { build_type: 'workflow' });
if (pages.status === 201 || pages.status === 204) {
  say('  ✓ 已开启 GitHub Pages（构建方式：GitHub Actions）');
} else if (pages.status === 409) {
  say('  · Pages 已经开过了');
} else {
  say(`  · Pages 需手动开启：仓库 Settings → Pages → Source 选 “GitHub Actions”`);
}

say('');
say('  ────────────────────────────────────────────────');
say(`  仓库地址 : https://github.com/${full}`);
say(`  Pages    : https://${login.toLowerCase()}.github.io/${repoName}/`);
say('');
say('  Pages 需要 Actions 跑完才可访问（约 1 分钟）。');
say('  在线使用还要把后端部署好，并把前端的 ?api= 指向它。');
say('  ────────────────────────────────────────────────');
say('');
