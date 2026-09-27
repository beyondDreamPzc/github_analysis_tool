'use strict';

/**
 * GitHub 仓库体检工具 —— 服务端
 *
 * 零第三方依赖：只用 Node 18+ 内置的 http / fs / path / dns / fetch。
 *
 * 接口：
 *   GET  /api/health                    健康探针（含 GitHub 出网可达性）
 *   GET  /api/analyze?repo=<url>&refresh=1   采集 + 规则评分，返回完整指标
 *   POST /api/ai-review                 基于已缓存的指标做 AI 点评（可携带 apiKey）
 *   GET  /api/limits                    查看当前 GitHub API 配额
 *   GET  /api/diag                      出网诊断（DNS / 各域名连通性 / 代理变量）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 轻量 .env 加载：避免引入 dotenv 依赖，同时保证配置在 lib 模块初始化前生效。
// 解析细节（去引号 / 去尾随空格 / 剥离行尾注释）见 lib/env.js。
require('./lib/env').loadDotEnv(__dirname);

const {
  analyzeRepo,
  parseRepoInput,
  ghFetch,
  GitHubError,
  cache,
  getConnectivity,
  probeConnectivity,
  getProxyStatus,
} = require('./lib/github');
const { computeScore, localReview, aiReview } = require('./lib/score');
const { candidateList, ensureActiveRelay, getActiveRelay, isDisabled: isRelayDisabled } = require('./lib/relay');
const { runDiagnostics, formatReport } = require('./lib/diag');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 静态资源指纹
 *
 * 静态文件带 1 小时强缓存，如果资源 URL 不变，升级代码后用户浏览器/边缘节点
 * 仍会继续跑旧版 JS（表现为「后端改了、页面没变」）。这里按文件大小+修改时间
 * 生成一个短指纹，注入到 index.html 的资源引用上：文件一变，URL 就变。
 */
const ASSET_VERSION = (() => {
  try {
    return ['app.js', 'styles.css', 'vendor/chart.umd.js']
      .map((f) => {
        const s = fs.statSync(path.join(PUBLIC_DIR, f));
        return `${s.size.toString(36)}${Math.floor(s.mtimeMs).toString(36)}`;
      })
      .join('')
      .slice(-10);
  } catch (_) {
    return Date.now().toString(36).slice(-10);
  }
})();

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // 目录穿越防护
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      // 前端是单页应用，未命中的非资源路径回落到 index.html
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return res.writeHead(404).end('Not Found');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(injectVersion(html));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    if (ext === '.html') {
      // HTML 不缓存，并把资源指纹注入进去，保证每次升级都能拿到新 JS/CSS
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(injectVersion(data));
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    }).end(data);
  });
}

function injectVersion(html) {
  return html.toString('utf8').replace(/__ASSET_VERSION__/g, ASSET_VERSION);
}

/** 把失败翻译成「下一步该做什么」 */
function buildFailureHint(err) {
  const status = err.status;
  const code = err.detail?.code;
  if (status === 404) {
    return '请检查仓库名拼写是否正确；本工具只支持公开仓库（私有仓库需要带权限的 Token）。';
  }
  if (status === 401) {
    return 'GitHub 拒绝了这串 Token（401 Bad credentials）：它可能已失效、被撤销，或复制时带了多余的空格 / 字符。'
      + '到页面「⚙️ 高级设置」里重新粘贴一个即可；也可以清空它，改用匿名配额（60 次/小时，多人共享）。';
  }
  if (status === 429) {
    return '网络是通的，只是这个出口 IP 的匿名配额（60 次/小时，多人共享）用完了。'
      + '推荐配上 GITHUB_TOKEN（免费，上限 5000 次/小时）根治；'
      + '临时也可经代理换一个出口 IP（设置 GITHUB_PROXY=http://127.0.0.1:7890 这类），会拿到另一份额度。';
  }
  if (status === 502 || status === 504 || code) {
    const relay = getActiveRelay();
    if (relay) {
      return `直连 api.github.com 失败，备用通道「${relay.name}」也没能取到数据（可能是网络波动或该仓库不存在）。`
        + '可点「重试」，或打开 /api/diag 看出网诊断。';
    }
    return '当前运行环境无法访问 api.github.com（DNS / 出网受限），且没有可用的备用通道。'
      + '可改用下方内置快照体验完整报告，或在本机运行本工具获得实时数据；'
      + '打开 /api/diag 可看到逐域名连通性诊断。';
  }
  return '请稍后重试；若持续失败，打开 /api/diag 查看出网诊断。';
}

async function handleAnalyze(req, res, url) {
  const input = url.searchParams.get('repo') || url.searchParams.get('url') || '';
  const parsed = parseRepoInput(input);
  if (!parsed) {
    return sendJson(res, 400, {
      error: '无法解析仓库地址',
      hint: '请输入形如 https://github.com/facebook/react 或 facebook/react 的公开仓库地址',
    });
  }
  const force = url.searchParams.get('refresh') === '1';
  // 顺手 trim：Token 里混进一个空格就会变成 401，而这个报错完全看不出是空格引起的
  const token = String(req.headers['x-github-token'] || '').trim() || process.env.GITHUB_TOKEN;

  let metrics;
  try {
    metrics = await analyzeRepo({ ...parsed, token, force });
  } catch (err) {
    // 采集失败时直接报错，不做"静默降级"。
    // 尤其 401：属于「配置问题」而不是「网络问题」，若悄悄换一份数据给用户，
    // 他会拿到一份看起来正常的报告，完全察觉不到自己的 Token 是坏的。
    const conn = getConnectivity();
    return sendJson(res, err.status || 502, {
      error: err.message,
      // 这个 code 会作为标签直接显示在失败面板上，所以必须反映真实性质：
      // 401 是凭据问题、403/429 是额度问题，标成 NETWORK 会把人引向错误的方向。
      code: err.status === 401 ? 'AUTH'
        : err.detail?.quotaExhausted ? 'QUOTA'
          : err.detail?.code || conn.code || 'NETWORK',
      hint: buildFailureHint(err),
      apiBase: conn.apiBase,
      githubReachable: conn.ok,
      diagUrl: '/api/diag',
    });
  }

  const score = computeScore(metrics);
  const review = localReview(metrics, score);

  sendJson(res, 200, {
    ok: true,
    repo: metrics,
    score,
    review,
    aiAvailable: Boolean(process.env.OPENAI_API_KEY || process.env.AI_API_KEY),
  });
}

async function handleAiReview(req, res) {
  const body = await readBody(req);
  const parsed = parseRepoInput(body.repo || '');
  if (!parsed) return sendJson(res, 400, { error: '缺少合法的 repo 参数' });

  const token = body.githubToken || process.env.GITHUB_TOKEN;
  const metrics = await analyzeRepo({ ...parsed, token });
  const score = computeScore(metrics);
  const review = await aiReview(metrics, score, {
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
    model: body.model,
  });
  sendJson(res, 200, { ok: true, review, scoreTotal: score.total });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      const conn = getConnectivity();
      // 页面可以自带 Token（存浏览器本地，不落盘），所以这里不能只看 process.env：
      // 否则用户明明已经在页面上填好，横幅却仍然说他「未配置」，前后自相矛盾。
      const reqToken = String(req.headers['x-github-token'] || '').trim();
      const envToken = Boolean(process.env.GITHUB_TOKEN);
      return sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        aiConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.AI_API_KEY),
        githubTokenConfigured: Boolean(reqToken || envToken),
        // 让前端能区分「页面填的」和「服务端配的」，好在横幅里给对应的反馈
        githubTokenSource: reqToken ? 'request' : (envToken ? 'env' : null),
        // 出网可达性：null 表示还没探测出结果
        githubReachable: conn.ok,
        githubConnectivity: conn,
        // 代理配置（凭据已打码）：Node 的 fetch 默认不读这些变量，本工具自行支持
        proxy: getProxyStatus(),
        // 备用通道状态：受限网络下能否照常实时体检，取决于这一项
        relay: { disabled: isRelayDisabled(), active: getActiveRelay()?.id || null },
      });
    }

    if (url.pathname === '/api/diag') {
      const report = await runDiagnostics({ source: 'api' });
      if (url.searchParams.get('format') === 'text') {
        const text = formatReport(report);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text);
      }
      return sendJson(res, 200, report);
    }

    if (url.pathname === '/api/limits') {
      const { data } = await ghFetch('/rate_limit');
      return sendJson(res, 200, { ok: true, core: data?.resources?.core || null });
    }

    if (url.pathname === '/api/analyze') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '仅支持 GET' });
      return await handleAnalyze(req, res, url);
    }

    if (url.pathname === '/api/ai-review') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' });
      return await handleAiReview(req, res);
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: '接口不存在' });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 500;
    const message = err instanceof GitHubError
      ? err.message
      : `服务端异常：${err.message}`;
    if (!(err instanceof GitHubError)) console.error('[error]', err);
    sendJson(res, status, { error: message, detail: err.detail || null });
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('┌───────────────────────────────────────────────┐');
  console.log('│  GitHub 仓库体检 · Repo Health Check          │');
  console.log('└───────────────────────────────────────────────┘');
  console.log(`  页面地址:   http://${shown}:${PORT}`);
  console.log(`  Node 版本:  ${process.version}`);
  console.log(`  GitHub Token: ${process.env.GITHUB_TOKEN ? '已配置（5000 次/小时）' : '未配置（60 次/小时，建议配置）'}`);
  const proxyStatus = getProxyStatus();
  console.log(`  出网代理:   ${proxyStatus.configured
    ? `已启用 · ${proxyStatus.via} → ${proxyStatus.url}`
    : '未配置（如需代理：设置 HTTPS_PROXY 或 GITHUB_PROXY）'}`);
  console.log(`  AI 点评:    ${process.env.OPENAI_API_KEY || process.env.AI_API_KEY ? '已配置（调用大模型）' : '未配置（使用内置规则引擎）'}`);
  console.log('  GitHub 出网: 探测中…（/rate_limit 不消耗配额）');
  console.log('');

  // 启动后异步探测出网能力，失败不阻塞服务
  probeConnectivity({ source: 'startup' })
    .then((conn) => {
      if (conn.ok) {
        const via = conn.proxy?.configured ? ` · 经代理 ${conn.proxy.via}` : '';
        const left = conn.rateLimit?.remaining;
        console.log(`[出网] 正常 · ${conn.ms}ms · 剩余配额 ${left ?? '?'}/${conn.rateLimit?.limit ?? '?'}${via}`);
        // 能连通但配额见底：这是后续所有请求都会 403 的前兆，必须提前说清楚
        if (left === 0 && !process.env.GITHUB_TOKEN) {
          console.log('[出网] ⚠ 匿名配额已耗尽：出网本身是通的，但 GitHub 会拒绝后续请求（HTTP 403）。');
          console.log('[出网]   根治：配置 GITHUB_TOKEN（60 → 5000 次/小时）。');
          console.log('[出网]   临时：换出口 IP，例如 GITHUB_PROXY=http://127.0.0.1:7890（会拿到独立额度）。');
        }
        return null;
      }
      console.log(`[出网] 直连不可用 —— ${conn.error}（code=${conn.code}）`);
      if (isRelayDisabled()) {
        console.log('[出网] 备用通道已被 GITHUB_RELAY=off 关闭，实时体检不可用');
        return null;
      }
      console.log('[出网] 正在寻找可用备用通道…');
      return ensureActiveRelay().then((relay) => {
        if (relay) {
          console.log(`[出网] 已启用备用通道：${relay.name}`);
          console.log('[出网] 中继通道不携带 Token，仅支持公开仓库');
        } else {
          const tried = candidateList().map((r) => r.name).join('、');
          console.log(`[出网] 无可用备用通道（已尝试：${tried}），实时体检不可用，将回退到内置快照`);
          console.log(`[出网] 诊断详情见 http://${shown}:${PORT}/api/diag?format=text`);
        }
      });
    })
    .catch((err) => console.log(`[出网] 探测异常：${err.message}`));
});
