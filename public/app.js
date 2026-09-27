/* ============================================================
   GitHub 仓库体检 —— 前端逻辑（原生 JS + Chart.js）
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);
const charts = {};
let state = { metrics: null, score: null, review: null };

/* ---------------- 主题 ---------------- */
const html = document.documentElement;
const savedTheme = localStorage.getItem('ghhc-theme');
html.setAttribute('data-theme', savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

function themeColors() {
  const s = getComputedStyle(html);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    text: v('--text'),
    muted: v('--text-muted'),
    border: v('--border'),
    accent: v('--accent'),
    grid: v('--border'),
    surface: v('--card'),
    soft: v('--bg-soft'),
    green: v('--green'),
    amber: v('--amber'),
    red: v('--red'),
    violet: v('--violet'),
    values: { text: v('--text'), muted: v('--text-muted'), border: v('--border'), accent: v('--accent'), card: v('--card'), soft: v('--bg-soft'), green: v('--green'), amber: v('--amber'), red: v('--red'), violet: v('--violet') },
  };
}

function applyChartDefaults() {
  const c = themeColors();
  Chart.defaults.color = c.muted;
  Chart.defaults.borderColor = c.grid;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11.5;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
}

$('themeToggle').addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('ghhc-theme', next);
  $('themeToggle').textContent = next === 'dark' ? '☀️' : '🌙';
  applyChartDefaults();
  if (state.metrics) renderCharts(); // 图表颜色跟随主题重绘
});
$('themeToggle').textContent = html.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';

/* ---------------- 高级设置 ---------------- */
const SETTING_KEYS = ['ghToken', 'aiBase', 'aiModel', 'aiKey'];
SETTING_KEYS.forEach((k) => {
  const el = $(k);
  el.value = localStorage.getItem('ghhc-' + k) || '';
  el.addEventListener('change', () => {
    localStorage.setItem('ghhc-' + k, el.value.trim());
    localStorage.setItem('ghhc-ai-dirty', '1');
    // 改完 Token 立刻重新询问服务端，让顶部横幅当场反映「已启用」，
    // 而不是逼用户刷新页面才知道有没有生效。
    if (k === 'ghToken') refreshHealth();
  });
});
$('settingsToggle').addEventListener('click', () => {
  const p = $('settingsPanel');
  p.hidden = !p.hidden;
  $('settingsToggle').classList.toggle('primary', !p.hidden);
});

/* ---------------- 工具函数 ---------------- */
function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
const fmtExact = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));
function fmtBytes(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromNow(iso) {
  if (!iso) return '—';
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219',
  Go: '#00ADD8', Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB',
  Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c', Vue: '#41b883',
  Svelte: '#ff3e00', Objective_C: '#438eff', 'Objective-C': '#438eff', Scala: '#c22d40',
  Perl: '#0298c3', Lua: '#000080', Haskell: '#5e5086', Elixir: '#6e4a7e', Clojure: '#db5855',
  Zig: '#ec915c', R: '#198CE7', Julia: '#a270ba', MATLAB: '#e16737', Jupyter_Notebook: '#DA5B0B',
  'Jupyter Notebook': '#DA5B0B', Makefile: '#427819', Dockerfile: '#384d54', PowerShell: '#012456',
  Assembly: '#6E4C13', TeX: '#3D6117', Solidity: '#AA6746', Groovy: '#4298b8', CoffeeScript: '#244776',
  Vim_Script: '#199f4b', 'Vim Script': '#199f4b', Emacs_Lisp: '#c065db', Batchfile: '#C1F12E',
};
const FALLBACK_PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#84cc16', '#f97316', '#06b6d4', '#a855f7'];

function langColor(name, idx) {
  const key = name.replace(/\s+/g, '_');
  return LANG_COLORS[name] || LANG_COLORS[key] || FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length];
}

/* ---------------- 搜索流程 ---------------- */
const form = $('searchForm');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('repoInput').value.trim();
  if (!value) return showAlert('请输入仓库地址', 'info');
  runAnalysis(value);
});

// 示例仓库用事件委托绑定：快照清单加载后按钮会被重绘，避免重复绑定丢事件
$('examples').addEventListener('click', (e) => {
  const btn = e.target.closest('.example');
  if (!btn) return;
  $('repoInput').value = `https://github.com/${btn.dataset.repo}`;
  runAnalysis(btn.dataset.repo);
});

function showAlert(msg, type) {
  const el = $('alert');
  el.hidden = false;
  const cls = type === 'info' ? ' info' : type === 'warn' ? ' warn' : '';
  el.className = 'alert' + cls;
  el.innerHTML = escapeHtml(msg);
}
const hideAlert = () => { $('alert').hidden = true; };

/* ---------------- 失败面板 & 环境提示 ---------------- */
// 单次失败时，把「原因 + 下一步」讲清楚，并给出可直接点击的兜底入口，
// 而不是甩一行 fetch failed 让用户自己猜。

function hideErrorPanel() { $('errorPanel').hidden = true; }

function renderErrorPanel(payload) {
  const el = $('errorPanel');
  const code = payload.code ? `<span class="err-code">${escapeHtml(payload.code)}</span>` : '';
  el.innerHTML = `
    <div class="err-head">⚠️ ${escapeHtml(payload.error || '分析失败')} ${code}</div>
    ${payload.hint ? `<div class="err-hint">${escapeHtml(payload.hint)}</div>` : ''}
    <div class="err-actions">
      <button class="btn small" id="errRetry">重试</button>
      <a class="btn small" href="/api/diag?format=text" target="_blank" rel="noopener">查看出网诊断</a>
    </div>`;
  el.hidden = false;
  const retry = el.querySelector('#errRetry');
  if (retry) retry.addEventListener('click', () => runAnalysis($('repoInput').value.trim() || payload.repo));
}

/** 顶部环境横幅：说清楚数据是从哪条链路来的 */
function renderConnBanner(health) {
  const el = $('connBanner');
  const conn = health.githubConnectivity || {};
  const relay = health.relay || {};
  const proxy = health.proxy || conn.proxy || {};

  // 情形零：能连通，但匿名配额已见底 —— 这是最常见的「看起来是连不上、其实是限流」。
  // 必须排在"经代理"提示之前，否则会被一条无害的蓝条盖住，用户继续一头雾水。
  const quotaLeft = conn.rateLimit?.remaining;
  if (health.githubReachable !== false && quotaLeft === 0 && !health.githubTokenConfigured) {
    el.className = 'conn-banner warn';
    el.innerHTML = `<strong>⚠️ 出网正常，但 GitHub 匿名配额已用尽（0/${conn.rateLimit?.limit ?? 60}）</strong>
      <span>这不是网络问题：TCP/TLS 都通，只是这个出口 IP 的免费额度（60 次/小时，多人共享）被用光了，
      GitHub 会对后续请求一律返回 HTTP 403。</span>
      <span><strong>根治：</strong>点右上角「⚙️ 高级设置」填入 Token（免费，额度升到 5000 次/小时且独享，填完立即生效、无需重启）；
      <strong>临时：</strong>换出口 IP，例如配 <code>GITHUB_PROXY=http://127.0.0.1:7890</code> 走代理拿到另一份额度。</span>
      <span><a href="/api/diag?format=text" target="_blank" rel="noopener">查看出网诊断 →</a></span>`;
    el.hidden = false;
    return;
  }

  // 情形一：能拿到数据，且确实是走的代理 —— 明确告知，避免误以为在直连
  if (health.githubReachable !== false) {
    // Token 来自当前页面时优先给出正反馈：用户刚填完，最想知道的就是「到底生效没有」。
    // 线上部署改不了服务端 .env，页面填写是唯一可行的配置方式，所以这里要说清楚。
    if (health.githubTokenSource === 'request') {
      el.className = 'conn-banner info';
      el.innerHTML = `<strong>✅ 已接收本页面的 GitHub Token</strong>
        <span>本次体检将用它访问 API，配额上限由 60 次/小时提升到 5000 次/小时（额度独享）。
        Token 只保存在你的浏览器本地，随请求头发送，不写入服务端磁盘。</span>
        <span>若它已失效（过期 / 被撤销）或复制时带了多余字符，体检会直接报 <strong>401 Bad credentials</strong> —— 重新生成一个再粘贴即可。</span>`;
      el.hidden = false;
      return;
    }
    if (proxy.configured) {
      el.className = 'conn-banner info';
      el.innerHTML = `<strong>ℹ️ 当前通过代理访问 GitHub API</strong>
        <span>代理来源 <code>${escapeHtml(proxy.via || '')}</code> → <code>${escapeHtml(proxy.url || '')}</code>。
        Node 内置 fetch 默认不读代理环境变量，本工具已自行接管该链路。</span>
        <span><a href="/api/diag?format=text" target="_blank" rel="noopener">查看出网诊断 →</a></span>`;
      el.hidden = false;
      return;
    }
    el.hidden = true;
    return;
  }

  const reason = `${escapeHtml(conn.error || '出网受限')}${conn.code ? `（${escapeHtml(conn.code)}）` : ''}`;

  let detail;
  if (relay.active) {
    detail = `已自动启用备用数据通道（<code>${escapeHtml(relay.active)}</code>），公开仓库仍可正常实时分析；`
      + '该通道为只读镜像，不携带 Token，因此私有仓库需在本机直连运行。';
  } else if (relay.disabled) {
    detail = '备用数据通道已被 <code>GITHUB_RELAY=off</code> 关闭。';
  } else {
    detail = '未找到可用的备用数据通道。建议在本机运行本工具获取实时数据。';
  }
  if (proxy.configured) {
    detail += `已配置代理（<code>${escapeHtml(proxy.via || '')}</code>）但仍不通，说明是代理本身不可用或目标被拦。`;
  }

  el.className = `conn-banner ${relay.active ? 'warn' : 'error'}`;
  el.innerHTML = `<strong>⚠️ 当前运行环境无法直连 GitHub API</strong>
    <span>${reason}。${detail}</span>
    <span><a href="/api/diag?format=text" target="_blank" rel="noopener">查看出网诊断 →</a></span>`;
  el.hidden = false;
}

const LOADING_STEPS = [
  '请求 GitHub API：基础信息 · 语言 · 贡献者 · 提交 · Release · Issue',
  '解析语言分布与体积占比…',
  '统计 52 周提交趋势与活跃度…',
  '计算协作广度、Issue 健康度…',
  '执行五维加权评分…',
];
let loadingTimer = null;

function startLoading() {
  hideAlert();
  $('result').hidden = true;
  $('loading').hidden = false;
  let i = 0;
  const tick = () => {
    document.querySelectorAll('.loading-steps .step').forEach((el, idx) => {
      el.classList.toggle('done', idx < i);
      el.classList.toggle('active', idx === i);
    });
    $('loadingStep').textContent = LOADING_STEPS[Math.min(i, LOADING_STEPS.length - 1)];
    if (i < 5) i++;
  };
  tick();
  loadingTimer = setInterval(tick, 1400);
}

function stopLoading() {
  clearInterval(loadingTimer);
  $('loading').hidden = true;
}

async function runAnalysis(input) {
  startLoading();
  hideErrorPanel();
  $('analyzeBtn').disabled = true;
  const token = $('ghToken').value.trim();
  try {
    const res = await fetch(`/api/analyze?repo=${encodeURIComponent(input)}`, {
      headers: token ? { 'x-github-token': token } : undefined,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      // 带上结构化信息（错误码 / 建议 / 可用快照）交给失败面板渲染
      renderErrorPanel({ ...data, repo: input });
      return;
    }

    state = { metrics: data.repo, score: data.score, review: data.review };
    stopLoading();
    render(data);
    if (data.repo.diagnostics?.viaRelay) {
      showAlert(`当前环境无法直连 GitHub API，本次数据经备用通道（${data.repo.diagnostics.viaRelay}）获取，仅含公开仓库信息。`, 'info');
    }

    // 数据完整性：部分接口取不到时，评分是基于残缺指标算出来的。
    // 这必须显式说出来——否则一个"看起来正常"的分数会误导用户，
    // 而实际原因常常是配额被打满（连中继也一样，见下方说明）。
    const failed = data.repo.diagnostics?.failed || [];
    if (failed.length) {
      const relayNote = data.repo.diagnostics?.viaRelay
        ? '备用通道的出口 IP 同样是公开共享的，也会被这套匿名配额限制，所以换通道并不能绕过。'
        : '';
      showAlert(
        `数据不完整：有 ${failed.length} 个接口没取到数据（贡献者 / 提交 / Issue / 社区档案等），`
        + `本次评分 ${data.score.total} 分是基于剩余指标计算的，可能低于真实水平。`
        + '最常见的原因是 GitHub 匿名配额（60 次/小时，按出口 IP 共享）被用尽。'
        + relayNote
        + '配置 GITHUB_TOKEN 可把上限提到 5000 次/小时且额度独享，是唯一根治办法。',
        'warn',
      );
    }
    const url = new URL(location.href);
    url.searchParams.set('repo', data.repo.meta.fullName);
    history.replaceState(null, '', url);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    renderErrorPanel({ error: err.message || '分析失败，请稍后重试', repo: input });
  } finally {
    stopLoading();
    $('analyzeBtn').disabled = false;
  }
}

/* ---------------- 主渲染 ---------------- */
function render(data) {
  const { repo, score, review } = data;
  $('result').hidden = false;
  applyChartDefaults();
  renderRepoCard(repo);
  renderScore(score, review);
  renderKpis(repo, score);
  renderLanguages(repo);
  renderIssuePanel(repo);
  renderContributors(repo);
  renderReview(review);
  renderDimensions(score);
  renderFlags(score.flags);
  renderCharts();
  $('rateLimitInfo').textContent = repo.diagnostics?.rateLimit
    ? `GitHub 配额剩余 ${repo.diagnostics.rateLimit.remaining ?? '?'}/${repo.diagnostics.rateLimit.limit ?? '?'}${repo.diagnostics.cached ? ' · 命中缓存' : ''}`
    : '';
}

function renderRepoCard(repo) {
  const m = repo.meta;
  $('repoAvatar').src = m.avatar || '';
  $('repoName').textContent = m.fullName;
  $('repoDesc').textContent = m.description || '（作者未填写项目简介）';
  document.title = `${m.fullName} · 仓库体检报告`;

  const badges = [];
  if (m.license) badges.push(`<span class="tag ok">📄 ${escapeHtml(m.license)}</span>`);
  else badges.push('<span class="tag bad">无许可证</span>');
  if (m.nativeLanguage) badges.push(`<span class="tag">${escapeHtml(m.nativeLanguage)}</span>`);
  if (m.archived) badges.push('<span class="tag bad">已归档</span>');
  if (repo.maintenance?.declared && !m.archived) badges.push('<span class="tag warn">⚠️ 已声明维护/废弃</span>');
  if (m.isFork) badges.push('<span class="tag warn">Fork 自其他项目</span>');
  if (m.ownerType === 'Organization') badges.push('<span class="tag">组织账号</span>');
  if (repo.activity.latestVersionTag) badges.push(`<span class="tag">最新版本 ${escapeHtml(repo.activity.latestVersionTag)}</span>`);
  $('repoBadges').innerHTML = badges.join('');

  $('repoTopics').innerHTML = m.topics.slice(0, 12).map((t) => `<span class="topic">${escapeHtml(t)}</span>`).join('');

  $('repoMeta').innerHTML = [
    ['创建时间', `${fmtDate(m.createdAt)}（${repo.meta.ageDays ? (repo.meta.ageDays / 365).toFixed(1) + ' 年' : '—'}）`],
    ['最近提交', `${fromNow(repo.activity.lastCommitAt)}`],
    ['最近发版', repo.activity.latestReleaseAt ? fromNow(repo.activity.latestReleaseAt) : '无 Release'],
    ['仓库体积', fmtBytes(m.sizeKB * 1024)],
    ['默认分支', escapeHtml(m.defaultBranch || '—')],
    ['开源协议', escapeHtml(m.licenseName || '未声明')],
    ['README', m.readmePresent ? `已提供（${fmtBytes(m.readmeSize)}）` : '缺失'],
    ['CI 工作流', repo.engineering.hasCi ? `${repo.engineering.workflowCount} 个` : '未配置'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  $('repoLink').href = m.url;
  const home = $('repoHome');
  if (m.homepage) { home.href = m.homepage.startsWith('http') ? m.homepage : `http://${m.homepage}`; home.hidden = false; }
  else home.hidden = true;
}

function renderScore(score, review) {
  const circumference = 2 * Math.PI * 82;
  const ratio = Math.max(0, Math.min(1, score.total / 100));
  const el = $('gaugeValue');
  el.style.strokeDasharray = `${(circumference * ratio).toFixed(1)} ${circumference.toFixed(1)}`;
  el.style.stroke = score.gradeInfo.color;
  $('scoreValue').textContent = score.total.toFixed ? score.total.toFixed(1) : score.total;
  $('scoreValue').style.color = score.gradeInfo.color;
  const badge = $('scoreGrade');
  badge.textContent = score.gradeInfo.grade;
  badge.style.background = score.gradeInfo.color;
  $('scoreGradeLabel').textContent = `${score.gradeInfo.label}${score.caps && score.caps.length ? `（${score.caps.map((c) => c.reason).join('、')}，已封顶）` : ''}`;
  $('scoreVerdict').textContent = review.verdict;
  $('scoreTags').innerHTML = (review.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  $('scoreSourceTag').textContent = review.source === 'llm' ? 'AI 模型' : '规则引擎';
  $('scoreSourceTag').className = 'tag ' + (review.source === 'llm' ? 'ai' : '');
}

function renderKpis(repo, score) {
  const p = repo.popularity;
  const a = repo.activity;
  const c = repo.community;
  const items = [
    ['⭐ Star', fmtExact(p.stars), `Fork/Star = ${(p.forkToStarRatio * 100).toFixed(1)}%`],
    ['🍴 Fork', fmtExact(p.forks), `衍生仓库 ${p.network ?? '—'} 个`],
    ['👀 Watcher', fmtExact(p.watchers), '持续关注者'],
    ['🐛 未关闭 Issue', fmtExact(p.openIssues), `采样关闭率 ${c.issueSample.closeRatio === null ? '—' : Math.round(c.issueSample.closeRatio * 100) + '%'}`],
    ['👥 贡献者', `${c.contributorCount}${c.contributorCountCapped ? '+' : ''}`, `总线因子 ${c.busFactor === null ? '—' : Math.round(c.busFactor * 100) + '%'}`],
    ['🚀 Release', fmtExact(a.releasesTotal), `近一年 ${a.releasesLastYear} 次`],
    ['📈 近 90 天提交', fmtExact(a.commitsLast90), `样本 ${a.sampledCommits} 次提交`],
    ['🏥 活跃基准分', score.dimensions.find((d) => d.key === 'activity').score + ' / 25', '活跃程度维度得分'],
  ];
  $('kpiGrid').innerHTML = items
    .map(([label, value, note]) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-note">${escapeHtml(String(note))}</div></div>`)
    .join('');
}

function renderLanguages(repo) {
  const list = repo.languages.list.slice(0, 10);
  $('langTotal').textContent = repo.languages.totalBytes ? `代码总量 ${fmtBytes(repo.languages.totalBytes)}` : '';
  $('langList').innerHTML = list
    .map((l, i) => {
      const color = langColor(l.name, i);
      return `<li>
        <span class="lang-dot" style="background:${color}"></span>
        <span class="lang-name">${escapeHtml(l.name)}<span class="lang-bar"><i style="width:${l.percent}%;background:${color}"></i></span></span>
        <span class="lang-pct">${l.percent}%</span>
      </li>`;
    })
    .join('') || '<li class="muted">未识别到语言数据</li>';
}

function renderIssuePanel(repo) {
  const s = repo.community.issueSample;
  const a = repo.activity;
  $('issueSummary').textContent = s.sampled ? `基于最近 ${s.sampled} 条 Issue/PR 采样` : '';
  $('issueStats').innerHTML = [
    ['采样 Issue 数', fmtExact(s.issues)],
    ['已关闭', fmtExact(s.closedIssues)],
    ['未关闭', fmtExact(s.openIssues)],
    ['关闭率', s.closeRatio === null ? '—' : `${Math.round(s.closeRatio * 100)}%`],
    ['平均关闭耗时', s.avgIssueCloseDays === null ? '—' : `${s.avgIssueCloseDays} 天`],
    ['采样中 PR 数', fmtExact(s.pullRequests)],
    ['官方社区健康度', repo.community.communityHealth === null ? '—' : `${repo.community.communityHealth}%`],
    ['平均发版间隔', a.avgReleaseGapDays === null ? '—' : `${a.avgReleaseGapDays} 天`],
  ].map(([k, v]) => `<li><span class="muted">${k}</span><b>${v}</b></li>`).join('');

  const releases = a.releaseSample || [];
  $('releaseList').innerHTML = releases.length
    ? `<div class="muted small" style="margin-bottom:4px">最近发布</div>` + releases
        .map((r) => `<div class="release-item"><span class="rel-tag">${escapeHtml(r.tag)}</span><span class="muted">${fmtDate(r.publishedAt)}${r.prerelease ? ' · 预发布' : ''}</span></div>`)
        .join('')
    : '<div class="muted small">该仓库暂无 Release 记录</div>';
}

function renderContributors(repo) {
  const c = repo.community;
  $('contributorSummary').textContent = c.contributorCount
    ? `共 ${c.contributorCount}${c.contributorCountCapped ? '+' : ''} 位贡献者 · Top3 占比 ${c.top3Share === null ? '—' : Math.round(c.top3Share * 100) + '%'}`
    : '';
}

function renderReview(review) {
  $('aiSummary').textContent = review.summary || '—';
  const fill = (id, arr) => {
    $(id).innerHTML = (arr && arr.length ? arr : ['—']).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  };
  fill('aiPros', review.pros);
  fill('aiCons', review.cons);
  fill('aiSuggestions', review.suggestions);
  $('aiSource').textContent = review.source === 'llm' ? `大模型 · ${review.model || 'LLM'}` : '内置规则引擎';
  $('aiSource').className = 'tag ' + (review.source === 'llm' ? 'ai' : '');
  $('aiNote').textContent = review.note || (review.source === 'llm'
    ? 'AI 评分仅基于上述量化指标生成，未阅读源码，请结合实际使用场景判断。'
    : '提示：在「高级设置」中填入 AI API Key，即可获得大模型生成的深度点评。');
}

function renderDimensions(score) {
  $('dimensionList').innerHTML = score.dimensions.map((d, idx) => `
    <div class="dimension" data-open="${idx === 0}">
      <div class="dimension-head" data-toggle="${idx}">
        <span class="dimension-name">${d.name}</span>
        <span class="dimension-bar"><i style="width:${d.percent}%;background:${score.gradeInfo.color}"></i></span>
        <span class="dimension-score">${d.score} / ${d.weight}</span>
        <span class="dimension-toggle">${idx === 0 ? '▲' : '▼'}</span>
      </div>
      <div class="factor-list" ${idx === 0 ? '' : 'hidden'}>
        ${d.factors.map((f) => `
          <div class="factor">
            <div class="factor-top">
              <span class="factor-label">${escapeHtml(f.label)}<span class="factor-value"> · ${escapeHtml(String(f.value))}</span></span>
              <span class="factor-value">${f.points} / ${f.max} 分</span>
            </div>
            <div class="factor-bar"><i style="width:${((f.points / f.max) * 100).toFixed(1)}%"></i></div>
            <div class="factor-note">${escapeHtml(f.note)}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');

  document.querySelectorAll('[data-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const box = head.parentElement;
      const body = box.querySelector('.factor-list');
      const open = body.hidden;
      body.hidden = !open;
      head.querySelector('.dimension-toggle').textContent = open ? '▲' : '▼';
    });
  });
}

function renderFlags(flags) {
  const icons = { danger: '🚨', warning: '⚠️', success: '✅', info: 'ℹ️' };
  $('flagList').innerHTML = flags.length
    ? flags.map((f) => `<li class="flag ${f.level}">
        <span class="flag-icon">${icons[f.level] || '•'}</span>
        <div><strong>${escapeHtml(f.title)}</strong><p>${escapeHtml(f.detail)}</p></div>
      </li>`).join('')
    : '<li class="muted">未检测到明显的风险或亮点信号。</li>';
}

/* ---------------- 图表 ---------------- */
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function renderCharts() {
  const repo = state.metrics;
  const score = state.score;
  if (!repo) return;
  const c = themeColors();
  const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 700 } };

  /* 雷达图：五维得分率 */
  destroyChart('radar');
  charts.radar = new Chart($('radarChart'), {
    type: 'radar',
    data: {
      labels: score.dimensions.map((d) => d.name),
      datasets: [{
        label: '得分率 %',
        data: score.dimensions.map((d) => d.percent),
        borderColor: c.accent,
        backgroundColor: hexA(c.accent, 0.16),
        pointBackgroundColor: c.accent,
        pointRadius: 3,
        borderWidth: 2,
      }],
    },
    options: {
      ...base,
      scales: {
        r: {
          suggestedMin: 0, suggestedMax: 100,
          angleLines: { color: c.grid },
          grid: { color: c.grid },
          pointLabels: { color: c.text, font: { size: 12 } },
          ticks: { display: false, stepSize: 25 },
        },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `得分率 ${ctx.raw}%` } } },
    },
  });

  /* 语言分布环形图 */
  destroyChart('lang');
  const langs = repo.languages.list.slice(0, 8);
  charts.lang = new Chart($('langChart'), {
    type: 'doughnut',
    data: {
      labels: langs.map((l) => l.name),
      datasets: [{
        data: langs.map((l) => l.percent),
        backgroundColor: langs.map((l, i) => langColor(l.name, i)),
        borderColor: c.surface,
        borderWidth: 2,
      }],
    },
    options: {
      ...base, cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw}%` } },
      },
    },
  });

  /* 52 周提交趋势 */
  destroyChart('weekly');
  const weekly = repo.activity.weekly || [];
  charts.weekly = new Chart($('weeklyChart'), {
    type: 'bar',
    data: {
      labels: weekly.map((w, i) => (i % 8 === 0 || i === weekly.length - 1 ? w.label : '')),
      datasets: [{
        label: '每周提交数',
        data: weekly.map((w) => w.count),
        backgroundColor: hexA(c.accent, 0.75),
        hoverBackgroundColor: c.accent,
        borderRadius: 3,
        maxBarThickness: 16,
      }],
    },
    options: {
      ...base,
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false, color: c.muted } },
        y: { beginAtZero: true, grid: { color: c.grid }, ticks: { precision: 0, color: c.muted } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => items[0].label || '—', label: (ctx) => `提交 ${ctx.raw} 次` } },
      },
    },
  });
  const total = weekly.reduce((a, w) => a + w.count, 0);
  $('commitSummary').textContent = `近 52 周共 ${total} 次提交（含合并）`;

  /* Issue 环形图 */
  destroyChart('issue');
  const s = repo.community.issueSample;
  charts.issue = new Chart($('issueChart'), {
    type: 'doughnut',
    data: {
      labels: ['已关闭 Issue', '未关闭 Issue'],
      datasets: [{
        data: [s.closedIssues, s.openIssues],
        backgroundColor: [c.green, c.amber],
        borderColor: c.surface,
        borderWidth: 2,
      }],
    },
    options: {
      ...base, cutout: '58%',
      plugins: { legend: { position: 'bottom', labels: { color: c.muted, padding: 12 } } },
    },
  });

  /* 贡献者排行 */
  destroyChart('contributors');
  const top = repo.community.topContributors.slice(0, 10);
  charts.contributors = new Chart($('contributorChart'), {
    type: 'bar',
    data: {
      labels: top.map((x) => x.login),
      datasets: [{
        label: '提交数',
        data: top.map((x) => x.contributions),
        backgroundColor: hexA(c.violet, 0.8),
        hoverBackgroundColor: c.violet,
        borderRadius: 4,
      }],
    },
    options: {
      ...base, indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, grid: { color: c.grid }, ticks: { color: c.muted } },
        y: { grid: { display: false }, ticks: { color: c.text, font: { size: 11.5 } } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

/** 支持 #rrggbb / rgb() 形式的颜色转 rgba */
function hexA(color, alpha) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? c.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : c;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

/* ---------------- AI 点评 ---------------- */
$('aiBtn').addEventListener('click', async () => {
  if (!state.metrics) return;
  const btn = $('aiBtn');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const res = await fetch('/api/ai-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: state.metrics.meta.fullName,
        apiKey: $('aiKey').value.trim() || undefined,
        baseUrl: $('aiBase').value.trim() || undefined,
        model: $('aiModel').value.trim() || undefined,
        githubToken: $('ghToken').value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'AI 点评失败');
    state.review = data.review;
    renderReview(data.review);
    $('scoreSourceTag').textContent = data.review.source === 'llm' ? 'AI 模型' : '规则引擎';
    $('scoreSourceTag').className = 'tag ' + (data.review.source === 'llm' ? 'ai' : '');
  } catch (err) {
    $('aiNote').textContent = `AI 点评失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '重新生成点评';
  }
});

/* ---------------- 导出报告 ---------------- */
$('exportBtn').addEventListener('click', () => {
  if (!state.metrics) return;
  const report = {
    tool: 'github-health-check',
    exportedAt: new Date().toISOString(),
    repo: state.metrics,
    score: state.score,
    review: state.review,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.metrics.meta.fullName.replace('/', '__')}-health-report.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------------- 首屏：支持 ?repo=owner/name 直接出报告 ---------------- */
applyChartDefaults();

// 问一次服务端「这台机器能不能直连 GitHub」，避免用户输完地址才发现环境不通。
// 必须带上页面里填的 Token —— 否则服务端按「未配置」回答，用户填完之后横幅还在说没配。
function refreshHealth() {
  const token = $('ghToken') ? $('ghToken').value.trim() : '';
  return fetch('/api/health', { headers: token ? { 'x-github-token': token } : undefined })
    .then((r) => r.json())
    .then((health) => {
      if (!health || !health.ok) return;
      renderConnBanner(health);
    })
    .catch(() => { /* 健康检查失败不影响主流程 */ });
}
refreshHealth();

const initialRepo = new URLSearchParams(location.search).get('repo');
if (initialRepo) {
  $('repoInput').value = initialRepo.includes('github.com') ? initialRepo : `https://github.com/${initialRepo}`;
  runAnalysis(initialRepo);
}
