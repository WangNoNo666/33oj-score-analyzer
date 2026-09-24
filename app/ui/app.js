/* 33OJ 成绩分析器 — 前端 */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('en-US'));

/* ---------- 后端地址 ----------
 * 默认同源（页面由后端一起提供）。如果前端被单独托管（例如 GitHub Pages），
 * 可以用 ?api=https://xxx 或界面上的输入框指定后端地址。
 */
const API_KEY = 'oj.api';
const URL_API = new URLSearchParams(location.search).get('api');
if (URL_API) localStorage.setItem(API_KEY, URL_API.replace(/\/+$/, ''));
const getApiBase = () => (localStorage.getItem(API_KEY) || '').replace(/\/+$/, '');
const setApiBase = (v) => (v ? localStorage.setItem(API_KEY, v.replace(/\/+$/, '')) : localStorage.removeItem(API_KEY));

/* ---------- 会话 Cookie（只存在 sessionStorage，关掉标签页就没了） ---------- */
const CK_KEY = 'oj.cookie';
const getCookieVal = () => sessionStorage.getItem(CK_KEY) || '';
const setCookieVal = (v) => (v ? sessionStorage.setItem(CK_KEY, v) : sessionStorage.removeItem(CK_KEY));

async function api(path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ck = getCookieVal();
  if (ck) headers['x-oj-cookie'] = ck;
  const r = await fetch(getApiBase() + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ============================ 状态检测 ============================ */

function setPill(el, ok, text) {
  el.className = 'pill ' + (ok === null ? '' : ok ? 'ok' : 'bad');
  el.querySelector('span:last-child').textContent = text;
}

async function refreshStatus() {
  setPill($('#pill-session'), null, '检测中…');
  let st;
  try {
    st = await api('/api/status');
  } catch (e) {
    setPill($('#pill-mode'), false, '未连接后端');
    setPill($('#pill-session'), false, '—');
    renderServerPrompt(e.message);
    return;
  }

  const cloud = st.mode === 'cloud';
  setPill($('#pill-mode'), true, cloud ? '在线模式' : '本机模式');
  setPill($('#pill-session'), st.session, st.session ? '会话有效' : '需要会话');

  renderSessionCard(st, cloud);
  if (st.session) loadYears();
}

const COOKIE_HELP = `
<details class="help">
  <summary>怎么拿到自己的 Cookie？</summary>
  <ol>
    <li>用浏览器打开并登录 <a href="https://oj.33dai.cn/d/TYOI/login" target="_blank" rel="noreferrer">oj.33dai.cn</a>；</li>
    <li>按 <b>F12</b> 打开开发者工具，切到 <b>Application / 应用</b> 面板；</li>
    <li>左侧 <b>Storage → Cookies → https://oj.33dai.cn</b>；</li>
    <li>找到 <b>sid</b> 和 <b>sid.sig</b> 两行，把它们的值复制出来；</li>
    <li>按 <code>sid=值1; sid.sig=值2</code> 的格式粘贴到下面。</li>
  </ol>
  <p class="help-note">
    或者在 <b>Network</b> 面板里随便点一个请求，从 Request Headers 里整段复制 <code>Cookie:</code> 后面的内容也可以。
  </p>
  <p class="help-note warn">
    这个 Cookie 等同于你的登录凭证。本站只用它去请求 oj.33dai.cn，<b>不会保存到服务器磁盘</b>，
    关闭标签页后本页面也不再保留。用完可以随时在 OJ 上退出登录使其失效。
  </p>
</details>`;

function renderSessionCard(st, cloud) {
  const box = $('#session-body');
  const has = !!getCookieVal();
  const base = getApiBase();

  const serverLine = base
    ? `<div class="serverline">后端：<code>${esc(base)}</code> <a href="#" id="srv-edit">修改</a></div>`
    : '';

  if (cloud) {
    box.innerHTML =
      serverLine +
      (st.session
        ? `<div class="okbox">✓ 会话可用，可以开始分析。</div>`
        : `<div class="errbox">${esc(st.error || '还没有可用的会话')}</div>`) +
      `<div class="field" style="margin-top:12px">
         <label>粘贴你的 OJ Cookie</label>
         <textarea id="ck" placeholder="sid=xxxxxxxx; sid.sig=yyyyyyyy" spellcheck="false"></textarea>
       </div>
       <button class="btn sm" id="ck-save">保存并验证</button>
       <button class="btn sm" id="ck-clear" style="margin-left:8px">清除</button>` +
      COOKIE_HELP;
  } else {
    box.innerHTML =
      serverLine +
      (st.session
        ? `<div class="okbox">✓ 已从本机 Edge 取到有效会话。</div>`
        : `<div class="errbox">${esc(st.error || '未检测到可用会话')}</div>
           <div class="warnbox">需要先打开一个已登录 oj.33dai.cn 的 Edge：<br>
             ① 双击 <b>start-edge.cmd</b>；<br>② 在弹出的窗口里登录；<br>③ 回来点「重新检测」。</div>`) +
      `<div style="height:10px"></div>
       <button class="btn sm" id="open-edge">启动 Edge（登录用）</button>
       <button class="btn sm" id="recheck" style="margin-left:8px">重新检测</button>` +
      `<details class="help"><summary>或者手动指定 Cookie</summary>
         <div class="field" style="margin-top:10px">
           <textarea id="ck" placeholder="sid=xxxxxxxx; sid.sig=yyyyyyyy" spellcheck="false"></textarea>
         </div>
         <button class="btn sm" id="ck-save">保存并验证</button>
         <button class="btn sm" id="ck-clear" style="margin-left:8px">清除</button>
       </details>` +
      COOKIE_HELP;
  }

  const ck = $('#ck');
  if (ck && has) ck.value = getCookieVal();

  if ($('#ck-save')) $('#ck-save').onclick = async () => {
    const v = ($('#ck').value || '').trim();
    if (!v) return alert('请先粘贴 Cookie');
    setCookieVal(v);
    await refreshStatus();
  };
  if ($('#ck-clear')) $('#ck-clear').onclick = async () => {
    setCookieVal('');
    if ($('#ck')) $('#ck').value = '';
    await refreshStatus();
  };
  if ($('#recheck')) $('#recheck').onclick = refreshStatus;
  if ($('#srv-edit')) $('#srv-edit').onclick = (e) => { e.preventDefault(); renderServerPrompt(''); };
  if ($('#open-edge')) $('#open-edge').onclick = async () => {
    try {
      await api('/api/open-edge', {});
      $('#session-body').insertAdjacentHTML('beforeend',
        '<div class="warnbox">已尝试启动 Edge。登录后点「重新检测」。</div>');
    } catch (e) { alert('启动失败: ' + e.message); }
  };
}

/** 页面没有连上后端时（例如单独托管的前端）显示服务器地址输入。 */
function renderServerPrompt(err) {
  $('#session-body').innerHTML =
    `<div class="errbox">${esc(err || '没有连接到后端服务')}</div>` +
    `<div class="field" style="margin-top:12px">
       <label>后端服务地址</label>
       <input type="text" id="srv" placeholder="https://your-app.onrender.com" value="${esc(getApiBase())}" />
       <div class="hint">填你部署好的后端地址（不带结尾斜杠）。也可以直接用 <code>?api=地址</code> 打开本页。</div>
     </div>
     <button class="btn sm" id="srv-save">连接</button>` +
    COOKIE_HELP;

  $('#srv-save').onclick = async () => {
    const v = ($('#srv').value || '').trim();
    if (!v) { setApiBase(''); return refreshStatus(); }
    if (!/^https?:\/\//i.test(v)) return alert('地址要以 http:// 或 https:// 开头');
    setApiBase(v);
    await refreshStatus();
  };
}

/* ============================ 年份 ============================ */

let selectedYears = new Set();

async function loadYears() {
  const domain = $('#domain').value;
  $('#years').innerHTML = '<span class="chip on" style="cursor:default">读取中…</span>';
  try {
    const r = await api('/api/years', { domain });
    $('#years-note').textContent = `（该域共 ${r.total} 场比赛）`;
    renderYears(r.years);
  } catch (e) {
    $('#years').innerHTML = `<span class="chip" style="cursor:default;color:var(--err)">读取失败: ${esc(e.message)}</span>`;
  }
}

function renderYears(years) {
  const box = $('#years');
  box.innerHTML = '';
  const all = document.createElement('div');
  all.className = 'chip' + (selectedYears.size === 0 ? ' on' : '');
  all.textContent = '全部';
  all.onclick = () => { selectedYears.clear(); renderYears(years); };
  box.appendChild(all);

  for (const y of years) {
    const c = document.createElement('div');
    c.className = 'chip' + (selectedYears.has(y.year) ? ' on' : '');
    c.innerHTML = `${y.year}<b>${y.count}</b>`;
    c.onclick = () => {
      selectedYears.has(y.year) ? selectedYears.delete(y.year) : selectedYears.add(y.year);
      renderYears(years);
    };
    box.appendChild(c);
  }
}

/* ============================ 运行 ============================ */

let running = false;

async function run() {
  if (running) return;
  const uids = $('#uids').value.split(/[,，\s]+/).filter(Boolean);
  if (!uids.length) { alert('请填写至少一个 UID'); return; }
  if (!$('#years').querySelector('.chip')) {
    const go = confirm('年份列表还没加载出来，将统计该域的「全部年份」。要继续吗？');
    if (!go) return;
  }

  running = true;
  $('#run').disabled = true;
  $('#run').textContent = '分析中…';
  $('#progress-card').style.display = '';
  $('#results').innerHTML = '';
  $('#log').innerHTML = '';
  setBar(0, '准备中…', '');

  let jobId;
  try {
    const r = await api('/api/run', {
      domain: $('#domain').value,
      uids,
      years: selectedYears.size ? [...selectedYears] : 'all',
      concurrency: Number($('#concurrency').value) || 5,
      titleFallback: $('#titleFallback').checked,
      noCache: $('#noCache').checked,
    });
    jobId = r.jobId;
  } catch (e) {
    showError(e.message);
    finishRun();
    return;
  }

  startWatch(jobId);
}

/**
 * 跟踪作业进度。
 * 同源时用 SSE（实时、省流量）；跨域部署时 EventSource 无法附带自定义请求头，
 * 所以改用轮询 /api/jobs/:id。
 */
function startWatch(jobId) {
  if (getApiBase()) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const s = await api(`/api/jobs/${jobId}`);
        if (s.progress) onProgress(s.progress);
        if (s.status === 'done') { stopped = true; return onDone(s.result); }
        if (s.status === 'error') { stopped = true; showError(s.error); return finishRun(); }
      } catch (e) {
        // 单次失败不致命，继续重试；连续失败交给下一次
      }
      setTimeout(tick, 800);
    };
    tick();
    return;
  }

  const es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'progress') onProgress(m.progress);
    else if (m.type === 'done') { es.close(); onDone(m.result); }
    else if (m.type === 'error') { es.close(); showError(m.message); finishRun(); }
  };
  es.onerror = () => { /* 服务端会正常结束连接 */ };
}

function finishRun() {
  running = false;
  $('#run').disabled = false;
  $('#run').textContent = '开始分析';
}

function setBar(pct, text, count) {
  $('#bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('#stage-text').textContent = text;
  $('#stage-count').textContent = count || '';
}

let lastLogKey = '';
function onProgress(p) {
  const { stage, message, current, total } = p;
  let pct = 0;
  if (stage === 'session') pct = 4;
  else if (stage === 'contests') pct = 10;
  else if (stage === 'boards') pct = 12 + (total ? (current / total) * 68 : 0);
  else if (stage === 'analyze') pct = 82 + (total ? (current / total) * 10 : 0);
  else if (stage === 'files') pct = 95;
  else if (stage === 'done') pct = 100;
  setBar(pct, message, total ? `${current}/${total}` : '');

  const key = stage + '|' + message;
  if (key === lastLogKey) return;
  lastLogKey = key;
  const line = document.createElement('div');
  line.className = 's-' + stage;
  line.textContent = message;
  const log = $('#log');
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function showError(msg) {
  const d = document.createElement('div');
  d.className = 'errbox';
  d.style.marginTop = '12px';
  d.textContent = '✗ ' + msg;
  $('#progress-card').appendChild(d);
  setBar(0, '出错了', '');
}

function onDone(result) {
  setBar(100, '完成', '');
  finishRun();
  render(result);
}

/* ============================ 渲染 ============================ */

function render(r) {
  const host = $('#results');
  host.innerHTML = '';
  const w = $('#welcome-card');
  if (w) w.style.display = 'none';

  /* --- 文件 --- */
  if (r.files && r.files.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>下载报告</h2><div class="files">${r.files
      .map(
        (f) =>
          `<a class="file" href="${esc(getApiBase())}/api/jobs/${encodeURIComponent(r.id)}/files/${encodeURIComponent(f.name)}" download>` +
          `<span class="ic">${f.kind === 'markdown' ? '📄' : '📊'}</span><span>${esc(f.name)}</span></a>`
      )
      .join('')}</div>`;
    host.appendChild(card);
  }

  /* --- 多人对比 --- */
  if (r.users.length > 1) host.appendChild(compareCard(r));

  /* --- 每个用户 --- */
  for (const u of r.users) host.appendChild(userCard(u, r));
}

function statHtml(k, v, cls = '') {
  return `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

function compareCard(result) {
  const us = result.users;
  const card = document.createElement('div');
  card.className = 'card';

  let html = '<h2>总览对比</h2>';
  html += '<div class="scroll" style="max-height:none"><table><thead><tr>';
  html += '<th class="l">用户</th><th>UID</th><th>参赛场次</th><th>参赛率</th><th>总分</th><th>平均分</th><th>中位数</th><th>标准差</th><th>最高分</th><th>最好排名</th><th>平均击败率</th>';
  html += '</tr></thead><tbody>';
  for (const u of us) {
    const o = u.overview;
    html += `<tr><td class="l"><b>${esc(o.uname)}</b></td><td>${o.uid}</td><td>${o.attended}</td><td>${o.participationRate}%</td>` +
      `<td>${fmtInt(o.total)}</td><td class="good"><b>${o.average}</b></td><td>${o.median}</td><td>${o.stdev}</td>` +
      `<td>${o.max}</td><td>${o.rankBest ? '#' + o.rankBest : '-'}</td><td>${o.beatAvg ?? '-'}%</td></tr>`;
  }
  html += '</tbody></table></div>';

  // 分年份 × 用户
  const yearSet = [...new Set(us.flatMap((u) => (u.byYear || []).map((y) => y.year)))].sort((a, b) => a - b);
  if (yearSet.length > 1) {
    html += '<h2 style="margin-top:20px">分年份平均分</h2>';
    html += `<div class="scroll" style="max-height:none"><table><thead><tr><th class="l">年份</th>${us
      .map((u) => `<th>${esc(u.overview.uname)}</th>`)
      .join('')}</tr></thead><tbody>`;
    for (const y of yearSet) {
      html += `<tr><td class="l">${y}</td>`;
      for (const u of us) {
        const b = (u.byYear || []).find((x) => x.year === y);
        html += b
          ? b.average === null
            ? `<td class="miss">未参加 <span style="color:var(--muted)">(${b.contestsTotal}场)</span></td>`
            : `<td><b>${b.average}</b> <span style="color:var(--muted)">(${b.attended}场)</span></td>`
          : '<td>-</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    // 柱状图
    const series = us.map((u) => ({
      name: u.overview.uname,
      values: yearSet.map((y) => {
        const b = (u.byYear || []).find((x) => x.year === y);
        return b && b.average !== null ? b.average : 0;
      }),
    }));
    html += `<div style="margin-top:14px">${groupedBarChart(yearSet, series, '平均分')}</div>`;
  }
  card.innerHTML = html;
  return card;
}

function userCard(u, result) {
  const o = u.overview;
  const card = document.createElement('div');
  card.className = 'card';

  let html = `<h2>${esc(o.uname)} · UID ${o.uid}</h2>`;

  html += '<div class="stats">';
  html += statHtml('平均分', o.average, 'hl');
  html += statHtml('参赛场次', `${o.attended} <small>/ ${o.contestsTotal}</small>`);
  html += statHtml('参赛率', o.participationRate + '%');
  html += statHtml('总分', fmtInt(o.total));
  html += statHtml('中位数', o.median);
  html += statHtml('标准差', o.stdev);
  html += statHtml('最高分', o.max, 'ok');
  html += statHtml('最低分', o.min, o.min === 0 ? 'warn' : '');
  html += statHtml('平均排名', o.rankAvg ?? '-');
  html += statHtml('最好排名', o.rankBest ? '#' + o.rankBest : '-', 'ok');
  html += statHtml('平均击败率', (o.beatAvg ?? '-') + '%');
  html += statHtml('场均高于均分', (o.avgDelta >= 0 ? '+' : '') + o.avgDelta, o.avgDelta >= 0 ? 'ok' : 'warn');
  html += '</div>';

  if (result.meta.byTitle && result.meta.byTitle.length) {
    html += `<div class="warnbox">⚠ ${result.meta.byTitle.length} 场比赛按标题归属年份、时间戳年份不符（OJ 录入错误）：${esc(
      result.meta.byTitle.join('、')
    )}</div>`;
  }

  // 逐月趋势
  if (u.monthly && u.monthly.length) {
    html += '<h2 style="margin-top:22px">月度趋势</h2>';
    html += lineChart(u.monthly.map((m) => m.month), u.monthly.map((m) => m.avg), '平均分');
    html += '<div class="scroll" style="margin-top:12px"><table><thead><tr><th class="l">月份</th><th>场次</th><th>总分</th><th>平均分</th><th>最高分</th><th>平均排名</th></tr></thead><tbody>';
    for (const m of u.monthly) {
      html += `<tr><td class="l">${m.month}</td><td>${m.n}</td><td>${fmtInt(m.sum)}</td><td><b>${m.avg}</b></td><td>${m.max}</td><td>${
        Number.isFinite(m.rankAvg) ? m.rankAvg : '-'
      }</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  // 题位
  if (u.byIndex && u.byIndex.length) {
    html += '<h2 style="margin-top:22px">各题位表现（按题位顺序对齐）</h2>';
    html += '<div class="scroll" style="max-height:none"><table><thead><tr><th class="l">题位</th><th>我参赛场次</th><th>我的平均得分</th><th>零分次数</th><th>全场平均</th><th>全场最高(均值)</th><th>相对全场</th></tr></thead><tbody>';
    for (const b of u.byIndex) {
      const rel = b.relative;
      html += `<tr><td class="l"><b>${esc(b.label)}</b></td><td>${b.n}</td><td>${b.userAvg}</td><td>${b.userZero}</td>` +
        `<td>${b.fieldAvg}</td><td>${b.fieldMaxAvg}</td><td class="${rel >= 1 ? 'good' : 'warn'}">${rel === null ? '-' : rel.toFixed(2) + '×'}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  // 逐场
  const entries = [...u.entries].sort((a, b) => b.begin - a.begin);
  html += `<h2 style="margin-top:22px">逐场明细（${entries.length} 场）</h2>`;
  if (!entries.length) {
    html += '<div class="empty">该范围内没有参赛记录</div>';
  } else {
    html += '<div class="scroll"><table><thead><tr><th class="l">日期</th><th class="l">比赛</th><th>得分</th><th>排名</th><th>参赛人数</th><th>全场均分</th><th>与均分差</th><th>击败率</th></tr></thead><tbody>';
    for (const e of entries) {
      const d = e.delta;
      html += `<tr><td class="l">${e.begin ? new Date(e.begin * 1000).toLocaleDateString('zh-CN') : '-'}${e.dateSuspect ? ' ⚠' : ''}</td>` +
        `<td class="l">${esc(e.title)}</td><td class="${e.score === 0 ? 'zero' : ''}"><b>${e.score}</b></td>` +
        `<td>${e.rank ? '#' + e.rank : '-'}</td><td>${e.fieldSize}</td><td>${e.fieldAvg}</td>` +
        `<td class="${d >= 0 ? 'good' : 'warn'}">${d >= 0 ? '+' : ''}${d}</td><td>${e.beatRate === null ? '-' : e.beatRate + '%'}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  // 未参加 / 拿不到成绩表
  if (u.missedCount || u.unavailable.length) {
    const bits = [];
    if (u.missedCount) bits.push(`${u.missedCount} 场比赛未参加`);
    if (u.unavailable.length) bits.push(`${u.unavailable.length} 场成绩表不可用（多被限流或未结束，已排除出统计）`);
    html += `<div class="warnbox">另有 ${bits.join('，')}。</div>`;
  }

  card.innerHTML = html;
  return card;
}

/* ============================ 图表 ============================ */

function groupedBarChart(labels, series, unit) {
  const W = 760, H = 240, PL = 48, PR = 14, PT = 16, PB = 34;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const nice = Math.ceil(max / 50) * 50 || 1;
  const groups = labels.length || 1;
  const gw = iw / groups;
  const bw = Math.max(6, (gw * 0.62) / series.length);
  const colors = ['#4c8dff', '#7ee0a1', '#d2a8ff', '#ffab70', '#ff8f8f', '#70d6ff'];

  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  for (let i = 0; i <= 4; i++) {
    const y = PT + (ih * i) / 4;
    const v = Math.round((nice * (4 - i)) / 4);
    s += `<line class="grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
    s += `<text class="axis" x="${PL - 7}" y="${y + 4}" text-anchor="end">${v}</text>`;
  }
  labels.forEach((lb, gi) => {
    s += `<text class="axis" x="${PL + gw * gi + gw / 2}" y="${H - PB + 18}" text-anchor="middle">${esc(lb)}</text>`;
    series.forEach((ser, si) => {
      const v = ser.values[gi] || 0;
      const h = (v / nice) * ih;
      const x = PL + gw * gi + gw / 2 - (bw * series.length) / 2 + bw * si;
      s += `<rect class="bar" x="${x}" y="${PT + ih - h}" width="${bw - 2}" height="${h}" rx="3" fill="${colors[si % colors.length]}">` +
        `<title>${esc(ser.name)} ${esc(lb)}: ${v}</title></rect>`;
      if (v > 0) s += `<text class="lbl" x="${x + (bw - 2) / 2}" y="${PT + ih - h - 5}" text-anchor="middle">${v}</text>`;
    });
  });
  s += `<line class="grid" x1="${PL}" y1="${PT + ih}" x2="${W - PR}" y2="${PT + ih}"/>`;
  let lx = PL;
  series.forEach((ser, si) => {
    s += `<rect x="${lx}" y="${H - 14}" width="9" height="9" rx="2" fill="${colors[si % colors.length]}"/>`;
    s += `<text class="axis" x="${lx + 14}" y="${H - 6}">${esc(ser.name)}</text>`;
    lx += 22 + String(ser.name).length * 12;
  });
  s += '</svg>';
  return s;
}

function lineChart(labels, values, unit) {
  const W = 760, H = 210, PL = 48, PR = 14, PT = 16, PB = 40;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(1, ...values);
  const nice = Math.ceil(max / 50) * 50 || 1;
  const n = Math.max(1, labels.length - 1);

  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  for (let i = 0; i <= 4; i++) {
    const y = PT + (ih * i) / 4;
    s += `<line class="grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
    s += `<text class="axis" x="${PL - 7}" y="${y + 4}" text-anchor="end">${Math.round((nice * (4 - i)) / 4)}</text>`;
  }
  const pts = values.map((v, i) => [PL + (iw * i) / n, PT + ih - (v / nice) * ih]);
  s += `<polyline class="line" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
  pts.forEach((p, i) => {
    s += `<circle class="pt" cx="${p[0]}" cy="${p[1]}" r="3.5"><title>${esc(labels[i])}: ${values[i]}</title></circle>`;
    const step = Math.ceil(labels.length / 12);
    if (i % step === 0) s += `<text class="axis" x="${p[0]}" y="${H - PB + 30}" text-anchor="middle" transform="rotate(-35 ${p[0]} ${H - PB + 30})">${esc(labels[i])}</text>`;
  });
  s += `<line class="grid" x1="${PL}" y1="${PT + ih}" x2="${W - PR}" y2="${PT + ih}"/>`;
  s += '</svg>';
  return s;
}

/* ============================ 绑定 ============================ */

$('#run').onclick = run;
$('#domain').onchange = () => { selectedYears.clear(); loadYears(); };

refreshStatus();
// 卡住时自动重试的轮询；正在跑作业时不动，免得刷掉进度
setInterval(() => { if (!running) refreshStatus(); }, 60000);
