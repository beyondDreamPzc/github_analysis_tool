'use strict';

/**
 * GitHub 数据采集层
 * - 零第三方依赖，基于 Node 18+ 内置 fetch
 * - 只调用公开 REST API，不写入任何数据
 * - 带内存缓存（默认 10 分钟），避免重复消耗配额
 */

const API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const RELAY_ATTEMPTS = Number(process.env.RELAY_ATTEMPTS || 3);
// 同一个请求最多换几个中继候选。公共中继的不稳定是常态，
// 只有真正换候选才能绕开"某个镜像开始抽风"的情况。
const RELAY_ROTATIONS = Number(process.env.RELAY_ROTATIONS || 2);

// 备选数据通道（受限网络下通过镜像/中继取只读公开数据）
const {
  ensureActiveRelay,
  isDisabled: isRelayDisabled,
  getActiveRelay,
  invalidateActiveRelay,
  penalizeRelay,
  penaltyState,
} = require('./relay');

/** relay.js 的降权判定（用于避免重复选中刚失败的候选） */
const isPenalizedRelay = (id) => penaltyState().some((p) => p.id === id);

// 出网代理（HTTPS_PROXY 等）。Node 内置 fetch 不读这些变量，必须自己接管。
const { httpGet, getProxyStatus } = require('./proxy');

const cache = new Map(); // key -> { ts, payload }

class GitHubError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'GitHubError';
    this.status = status || 502;
    this.detail = detail || null;
  }
}

/** 从各种输入中解析出 owner / repo，支持完整 URL、git 地址、owner/repo 简写 */
function parseRepoInput(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  raw = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const fromUrl = raw.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+)\/([^/?#]+)/i
  );
  if (fromUrl) return normalize(fromUrl[1], fromUrl[2]);

  const shorthand = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return normalize(shorthand[1], shorthand[2]);

  return null;
}

function normalize(owner, repo) {
  const clean = (s) => s.replace(/[^\w.-]/g, '');
  const o = clean(owner);
  const r = clean(repo.replace(/#.*$/, ''));
  if (!o || !r) return null;
  return { owner: o, repo: r, fullName: `${o}/${r}` };
}

/**
 * 把 fetch 抛出的底层错误翻译成人能看懂的根因。
 * Node 的 fetch 在出网被拦时只会给一句 `fetch failed`，
 * 真正的错误码藏在 err.cause.code 里（ENOTFOUND / ECONNRESET / …）。
 */
function describeFetchError(err, timeoutMs = REQUEST_TIMEOUT) {
  if (err?.name === 'AbortError') {
    return { message: `请求 GitHub 超时（超过 ${timeoutMs}ms 无响应）`, code: 'TIMEOUT' };
  }
  const code = err?.cause?.code || err?.code || null;
  const KNOWN = {
    ENOTFOUND: 'DNS 解析失败：找不到 api.github.com（网络受限或 DNS 被污染）',
    EAI_AGAIN: 'DNS 解析超时：无法解析 api.github.com',
    ECONNREFUSED: '连接被拒绝：目标端口不可达（可能被防火墙拦截）',
    ECONNRESET: '连接被重置：出网请求被拦断（常见于受限的部署环境）',
    ETIMEDOUT: 'TCP 连接超时：网络不通',
    UND_ERR_CONNECT_TIMEOUT: 'TCP 连接超时：网络不通',
    UND_ERR_SOCKET: '连接中断：socket 被提前关闭',
    CERT_HAS_EXPIRED: 'TLS 证书校验失败',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败（可能存在中间人代理）',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书校验失败（自签名证书）',
  };
  const message = KNOWN[code] || `网络请求失败：${err?.message || '未知错误'}`;
  return { message, code: code || 'FETCH_FAILED' };
}

/**
 * 单次 HTTP 请求（直连或经中继），负责发请求并把响应翻译成结果 / 异常。
 * viaRelayId 非空表示这次走的备选通道。
 */
async function requestOnce({ url, path, headers, method, raw, viaRelayId, authenticated }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // 配了代理走 CONNECT 隧道，没配就沿用内置 fetch
    const res = await httpGet(url, { method, headers, timeout: REQUEST_TIMEOUT, signal: controller.signal });
    const rateLimit = {
      remaining: num(res.headers.get('x-ratelimit-remaining')),
      limit: num(res.headers.get('x-ratelimit-limit')),
      resetAt: num(res.headers.get('x-ratelimit-reset')),
      authenticated: Boolean(authenticated),
    };
    const meta = { path, viaRelay: viaRelayId || null, viaProxy: res._viaProxy === true };

    if (raw) return { res, rateLimit, viaRelay: meta.viaRelay, viaProxy: meta.viaProxy };

    if (res.status === 404) {
      throw new GitHubError('仓库或资源不存在（可能是私有仓库、已删除或拼写错误）', 404, meta);
    }
    if (res.status === 401) {
      // 401 和 403 是两回事，必须分开说：403 多半是配额或策略，401 是「这串凭据我不认」。
      // 混在一起会让用户往完全错的方向排查 —— 去查网络、去换 IP，而其实该重新生成 Token。
      throw new GitHubError(
        'GitHub 拒绝了本次身份验证（401 Bad credentials）。若你配置了 Token，'
          + '最常见的原因是它已失效 —— 已过期、被撤销，或复制时带上了多余的空格 / 字符。'
          + '可在页面「⚙️ 高级设置」里重新粘贴，或清空它改用匿名配额（60 次/小时）。',
        401,
        { ...meta, quotaExhausted: false },
      );
    }
    if (res.status === 403 || res.status === 429) {
      const reset = rateLimit.resetAt ? new Date(rateLimit.resetAt * 1000) : null;
      // 经代理时 403 很可能来自代理自身的策略（白名单代理常见），不能一律说成 GitHub 限流
      if (meta.viaProxy && res.status === 403 && rateLimit.remaining !== 0) {
        throw new GitHubError(
          '请求被代理服务器拒绝（HTTP 403）——部分白名单代理只放行 api.github.com 的个别路径。'
          + '可改用 GITHUB_PROXY 指定另一个代理。',
          403,
          { ...meta, rateLimit },
        );
      }
      // 配额耗尽 ≠ 连不上。这是最容易误判的一类失败：
      // TCP/TLS 全程正常，GitHub 也回了响应，只是回了一句「你这个出口 IP 的匿名额度用完了」。
      // 未认证的 60 次/小时是**按出口 IP 共享**的（家宽 / CGNAT / 公司出口都是一堆人共用），
      // 所以经常出现「刚才还好好的，突然全 403」——不是网络坏了，是隔壁把额度用光了。
      const msg = rateLimit.remaining === 0
        ? `GitHub 匿名配额已用完（${rateLimit.limit || 60} 次/小时，按出口 IP 共享）${reset ? `，将于 ${reset.toLocaleString('zh-CN')} 恢复` : ''}。`
          + '注意：这是配额问题，不是网络不通（TCP/TLS 均正常）。'
          + '两个办法：① 配置 GITHUB_TOKEN，上限从 60 提升到 5000 次/小时（推荐，根治）；'
          + '② 换一个出口 IP，例如经代理访问（GITHUB_PROXY），会拿到另一份独立额度。'
        : '请求被 GitHub 拒绝（可能触发了限流）';
      throw new GitHubError(msg, 429, { ...meta, rateLimit, quotaExhausted: rateLimit.remaining === 0 });
    }
    if (res.status === 202) {
      // 统计接口在 GitHub 缓存预热中，返回空数据交由上层重试
      return { data: null, pending: true, rateLimit, viaRelay: meta.viaRelay, viaProxy: meta.viaProxy };
    }
    if (!res.ok) {
      let detail = null;
      try { detail = await res.json(); } catch (_) { /* ignore */ }
      throw new GitHubError(`GitHub 接口返回 ${res.status}`, res.status, { ...meta, detail });
    }

    const data = await res.json();
    return { data, rateLimit, res, viaRelay: meta.viaRelay, viaProxy: meta.viaProxy };
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    const { message, code } = describeFetchError(err);
    // 网络层失败时顺手刷新一次连通性状态，页面上就能直接看到「为什么连不上」
    if (code !== 'TIMEOUT') probeConnectivity({ source: 'request-failure' }).catch(() => {});
    throw new GitHubError(`无法连接 GitHub API：${message}`, code === 'TIMEOUT' ? 504 : 502, {
      path,
      code,
      network: true,   // 标记为网络层故障 → 触发中继重试
      apiBase: API_BASE,
      viaRelay: viaRelayId || null,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带超时、错误归一化、中继回退的 GET。
 *
 * 三种情形：
 *   1. 直连正常 → 直连（默认）
 *   2. 已知直连不可用（探测过且失败）→ 直接走中继，省掉每次请求先等超时的几秒钟
 *   3. 直连未知 → 先直连，网络层失败或配额耗尽时再自动切中继
 *
 * 走中继时**不携带 Authorization**，Token 不出本机。
 */
async function ghFetch(path, { token, method = 'GET', raw = false, allowRelay = true } = {}) {
  const authToken = token || process.env.GITHUB_TOKEN;
  const baseHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-health-check/1.0',
  };
  const directHeaders = authToken ? { ...baseHeaders, Authorization: `Bearer ${authToken}` } : baseHeaders;
  const directUrl = path.startsWith('http') ? path : API_BASE + path;
  const relayEligible = allowRelay && !isRelayDisabled() && !path.startsWith('http');

  const attemptDirect = () => requestOnce({
    url: directUrl, path, headers: directHeaders, method, raw, viaRelayId: null, authenticated: authToken,
  });

  // 返回 null 表示当前没有可用中继
  const attemptRelay = async () => {
    const tried = [];
    let lastErr = null;

    // 外层：候选轮换。内层：同一个中继的瞬时故障重试。
    // 只有外层轮换才能真正绕开"某个公共中继开始不稳定"的情况——
    // 否则会抱着一个坏中继重试到缓存过期，表现就是页面时好时坏。
    for (let round = 0; round < RELAY_ROTATIONS; round++) {
      let relay = getActiveRelay();
      if (relay && (tried.includes(relay.id) || isPenalizedRelay(relay.id))) relay = null;
      if (!relay) relay = await ensureActiveRelay({ exclude: tried }).catch(() => null);
      if (!relay) break;                       // 一个候选都没有
      if (tried.includes(relay.id)) break;     // 已无新候选可换

      tried.push(relay.id);

      let roundErr = null;
      for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt++) {
        try {
          return await withRelaySlot(async () => {
            // 关键时点：候选是在"抢到并发槽之前"选定的，而 10 路并发的其余请求
            // 可能在这段排队时间里已经把该中继判坏了。这里再确认一次，
            // 避免明知不可用还硬打——否则一次体检会往坏中继上白打几十个请求。
            if (isPenalizedRelay(relay.id)) throw relayPenalizedError();
            return requestOnce({
              url: relay.build(path), path, headers: baseHeaders, method, raw, viaRelayId: relay.id, authenticated: false,
            });
          });
        } catch (err) {
          roundErr = lastErr = err;
          // 业务错误（404 / 配额 / 仓库不存在）换中继也没用，直接抛出
          if (!isTransient(err)) throw err;
          if (attempt === RELAY_ATTEMPTS) break;
          // 并发场景下，别的请求可能已经判定这个中继坏了。没必要时别再把无谓的
          // 重试打到一个已知坏掉的中继上（10 路并发时这点浪费会被放大）。
          if (isPenalizedRelay(relay.id)) {
            console.log(`[relay] ${relay.name} 已被其他请求判定不可用，跳过剩余重试`);
            break;
          }
          console.log(`[relay] ${relay.name} 第 ${attempt} 次失败（${err.status || err.detail?.code}），重试…`);
          await sleep(400 * attempt + Math.floor(Math.random() * 200));
        }
      }

      // 换个中继继续。降权 + 强制重探，避免坏候选被粘住 30 分钟。
      console.log(`[relay] ${relay.name} 连续失败，降权并切换到下一个候选…`);
      penalizeRelay(relay.id);
      invalidateActiveRelay();
      lastErr = roundErr || lastErr;
    }

    if (lastErr) throw lastErr;
    return null;   // 确实没有候选可用
  };

  // 情形 2：已知直连不可用，别让每个请求都白等一次超时
  if (relayEligible && directKnownBad()) {
    let relayErr = null;
    try {
      const out = await attemptRelay();
      if (out) return out;
    } catch (err) {
      relayErr = err;
      console.log(`[relay] 本次请求中继失败（${err.status || err.detail?.code}）：${firstSentence(err.message)}`);
    }

    // 直连也可能已经恢复，最后再试一次。两条错误都要保留，
    // 否则用户只会看到"DNS 解析失败"，完全不知道我们试过备用通道。
    try {
      return await attemptDirect();
    } catch (directErr) {
      if (relayErr) {
        throw new GitHubError(buildDualFailure(directErr, relayErr), dualStatus(directErr, relayErr), {
          path,
          code: directErr.detail?.code || 'RELAY_FAILED',
          network: true,
          apiBase: API_BASE,
          relayTried: true,
        });
      }
      throw directErr;
    }
  }

  try {
    return await attemptDirect();
  } catch (err) {
    // 值得重试的两类失败：网络层不通（域名被拦 / DNS 污染），以及配额耗尽
    const retryable = err instanceof GitHubError && (err.detail?.network || err.status === 429);
    if (!retryable || !relayEligible) throw err;

    let relayErr = null;
    try {
      const out = await attemptRelay();
      if (out) return out;
    } catch (e) {
      relayErr = e;
    }

    if (relayErr) {
      throw new GitHubError(buildDualFailure(err, relayErr), dualStatus(err, relayErr), {
        path,
        code: err.detail?.code || (err.status === 429 ? 'QUOTA' : undefined),
        network: Boolean(err.detail?.network),
        apiBase: API_BASE,
        relayTried: true,
      });
    }

    // 直连失败，且连一个可用的备用通道都没有 —— 这个事实必须说出来
    throw new GitHubError(`${err.message}；且当前未找到可用的备用通道。`, err.status || 502, {
      ...(err.detail || {}),
      path,
      relayUnavailable: true,
    });
  }
}

/** 取错误信息的第一句，避免两条长文案串在一起难以阅读 */
const firstSentence = (msg) => String(msg || '').split('。')[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 中继在排队等并发槽期间被别人判坏时，用它把控制权交回轮换逻辑 */
function relayPenalizedError() {
  const err = new Error('中继已被判定不可用');
  err.status = 503;
  err.detail = { relayPenalized: true, network: true };
  return err;
}

/**
 * 中继并发闸门。
 *
 * 体检要打 10 个接口，直连时并行没问题；但公共镜像对突发流量很敏感，
 * 10 路并发 + 失败重试会在瞬间打出几十个请求，容易被直接限流（表现为整批失败）。
 * 这里把经中继的请求限制在 3 路并发，其余排队。
 */
const RELAY_CONCURRENCY = Number(process.env.RELAY_CONCURRENCY || 3);
let relayInFlight = 0;
const relayWaiters = [];

async function withRelaySlot(fn) {
  if (relayInFlight >= RELAY_CONCURRENCY) {
    await new Promise((resolve) => relayWaiters.push(resolve));
  }
  relayInFlight++;
  try {
    return await fn();
  } finally {
    relayInFlight--;
    const next = relayWaiters.shift();
    if (next) next();
  }
}

/** 是否是值得重试的瞬时故障（网络中断 / 上游 5xx），业务错误不重试 */
function isTransient(err) {
  if (err?.detail?.network) return true;
  return [500, 502, 503, 504].includes(err?.status);
}

function dualStatus(err, relayErr) {
  if (err.status === 429 && relayErr.status === 429) return 429;
  return 502;
}

function buildDualFailure(err, relayErr) {
  // 两边都是配额耗尽是最常见的组合，单独给一句人话
  if (err.status === 429 && relayErr.status === 429) {
    return `直连与备用通道的 API 配额都已用完（备用通道将于 ${resetHint(relayErr)} 恢复）。`
      + '可配置 GITHUB_TOKEN 把上限从 60 次/小时提升到 5000 次/小时，或稍后重试。';
  }
  const relayReason = firstSentence(relayErr.message).replace(/^无法连接 GitHub API：/, '');
  return `直连失败（${firstSentence(err.message)}）；备用通道也不可用（${relayReason}）。可稍后重试。`;
}

function resetHint(err) {
  const resetAt = err.detail?.rateLimit?.resetAt;
  if (!resetAt) return '稍后';
  return new Date(resetAt * 1000).toLocaleTimeString('zh-CN');
}

async function safeFetch(path, opts) {
  try {
    return await ghFetch(path, opts);
  } catch (err) {
    return { data: null, error: err.message, status: err.status || 500, viaProxy: false };
  }
}

/* ---------------- 连通性探测 ---------------- */

const PROBE_TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 6000);

let connectivity = {
  ok: null,          // null = 还没探测过
  checkedAt: null,
  ms: null,
  error: null,
  code: null,
  source: null,
  apiBase: API_BASE,
  rateLimit: null,
};

/**
 * 探测本进程到 GitHub API 的出网能力。
 * 用 /rate_limit 做探针——这个接口不消耗 API 配额，可以放心频繁调用。
 */
async function probeConnectivity({ source = 'manual', timeout = PROBE_TIMEOUT } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'github-health-check/1.0' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const proxy = getProxyStatus(API_BASE);

  try {
    const res = await httpGet(`${API_BASE}/rate_limit`, { headers, timeout, signal: controller.signal });
    const data = await res.json().catch(() => null);
    const core = data?.resources?.core || null;
    connectivity = {
      ok: res.ok,
      checkedAt: new Date().toISOString(),
      ms: Date.now() - started,
      error: res.ok ? null : `GitHub 返回 HTTP ${res.status}`,
      code: res.ok ? null : `HTTP_${res.status}`,
      source,
      apiBase: API_BASE,
      proxy,
      rateLimit: core ? { remaining: core.remaining, limit: core.limit } : null,
    };
  } catch (err) {
    const { message, code } = describeFetchError(err, timeout);
    connectivity = {
      ok: false,
      checkedAt: new Date().toISOString(),
      ms: Date.now() - started,
      error: message,
      code,
      source,
      apiBase: API_BASE,
      proxy,
      rateLimit: null,
    };
  } finally {
    clearTimeout(timer);
  }
  return connectivity;
}

const getConnectivity = () => connectivity;

const DIRECT_BAD_TTL = Number(process.env.DIRECT_BAD_TTL_MS || 5 * 60 * 1000);

/**
 * 直连是否处于「已知不可用」状态。
 * 只认最近的探测结果：超过 TTL 就重新尝试直连，避免网络恢复后还一直走中继。
 */
function directKnownBad() {
  if (connectivity.ok !== false || !connectivity.checkedAt) return false;
  return Date.now() - new Date(connectivity.checkedAt).getTime() < DIRECT_BAD_TTL;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const STALE_KEYWORDS = [
  'deprecated', 'maintenance mode', 'no longer maintained', 'unmaintained',
  'no longer actively', 'not actively maintained', 'no longer being developed',
  'stopped development', 'end of life', 'end-of-life', 'legacy project',
  'sunset', '不再维护', '停止维护', '已废弃', '不再更新',
];

/**
 * 扫描 README 顶部内容，识别「未归档但已停止维护」的项目状态。
 * 只看前 3000 字符并对 eol / deprecated 做词边界匹配，尽量避免误伤普通的功能级弃用说明。
 */
function scanMaintenanceStatus(readmeData) {
  const empty = { declared: false, keywords: [], excerpt: '' };
  if (!readmeData || !readmeData.content) return empty;

  let text;
  try {
    text = Buffer.from(readmeData.content, 'base64').toString('utf8');
  } catch (_) {
    return empty;
  }

  const head = text.slice(0, 3000);
  const lower = head.toLowerCase();
  const matched = new Set();
  let firstIndex = -1;

  for (const kw of STALE_KEYWORDS) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      matched.add(kw);
      if (firstIndex === -1 || idx < firstIndex) firstIndex = idx;
    }
  }
  if (/\beol\b/.test(lower)) {
    matched.add('eol');
    const i = lower.search(/\beol\b/);
    if (firstIndex === -1 || i < firstIndex) firstIndex = i;
  }

  if (matched.size === 0) return empty;

  const excerpt = text
    .slice(Math.max(0, firstIndex - 90), firstIndex + 190)
    .replace(/[#>*_[\]()!`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { declared: true, keywords: [...matched], excerpt };
}

/** 解析 Link 头，拿到分页总数（最后一页页码 * per_page 是上限估算） */
function totalFromLink(res) {  const link = res.headers.get('link');
  if (!link) return null;
  const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (!m) return null;
  const perPage = Number(new URL(res.url).searchParams.get('per_page') || 30);
  return Number(m[1]) * perPage;
}

function daysBetween(a, b) {
  return Math.round((a - b) / 86400000);
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 聚合单个仓库的完整指标
 */
async function collectRepoMetrics({ owner, repo, token }) {
  const base = `/repos/${owner}/${repo}`;
  const now = Date.now();

  const repoRes = await ghFetch(base, { token });
  const info = repoRes.data;
  let rateLimit = repoRes.rateLimit;

  const [languages, contributors, commits, releases, issues, participation, community, readme, rootContents, workflows] =
    await Promise.all([
      safeFetch(`${base}/languages?per_page=100`, { token }),
      safeFetch(`${base}/contributors?per_page=100&anon=1`, { token }),
      safeFetch(`${base}/commits?per_page=100`, { token }),
      safeFetch(`${base}/releases?per_page=20`, { token }),
      safeFetch(`${base}/issues?state=all&per_page=100&sort=created&direction=desc`, { token }),
      safeFetch(`${base}/stats/participation`, { token }),
      safeFetch(`${base}/community/profile`, { token }),
      safeFetch(`${base}/readme`, { token, raw: false }),
      safeFetch(`${base}/contents/`, { token }),
      safeFetch(`${base}/contents/.github/workflows?per_page=100`, { token }),
    ]);

  // 统计接口首次访问常返回 202，稍等后重试一次
  let participationData = participation.data;
  if (participation.pending) {
    await new Promise((r) => setTimeout(r, 1800));
    const retry = await safeFetch(`${base}/stats/participation`, { token });
    participationData = retry.data;
  }

  const langBytes = languages.data || {};
  const langTotal = Object.values(langBytes).reduce((a, b) => a + b, 0);
  const languageList = Object.entries(langBytes)
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: langTotal ? +((bytes / langTotal) * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const contributorList = Array.isArray(contributors.data)
    ? contributors.data.filter((c) => c && c.login)
    : [];
  const contributorTotal = contributorList.reduce((a, c) => a + (c.contributions || 0), 0);

  const commitList = Array.isArray(commits.data) ? commits.data : [];
  const commitDates = commitList
    .map((c) => toDate(c?.commit?.author?.date))
    .filter(Boolean)
    .sort((a, b) => b - a);

  const lastCommit = commitDates[0] || toDate(info.pushed_at) || toDate(info.updated_at);
  const daysSinceLastCommit = lastCommit ? daysBetween(now, lastCommit.getTime()) : null;
  const commitsLast30 = commitDates.filter((d) => daysBetween(now, d.getTime()) <= 30).length;
  const commitsLast90 = commitDates.filter((d) => daysBetween(now, d.getTime()) <= 90).length;
  const commitsLast365 = commitDates.filter((d) => daysBetween(now, d.getTime()) <= 365).length;

  // 周提交序列（优先用官方 participation，缺失则用提交样本按周聚合）
  let weekly = null;
  if (participationData && Array.isArray(participationData.all)) {
    weekly = participationData.all.map((count, idx) => {
      const weeksAgo = participationData.all.length - 1 - idx;
      return { weeksAgo, count, label: weeksAgo === 0 ? '本周' : `${weeksAgo}周前` };
    });
  } else {
    const buckets = new Array(52).fill(0);
    commitDates.forEach((d) => {
      const w = Math.floor(daysBetween(now, d.getTime()) / 7);
      if (w >= 0 && w < 52) buckets[51 - w] += 1;
    });
    weekly = buckets.map((count, idx) => ({
      weeksAgo: 51 - idx,
      count,
      label: idx === 51 ? '本周' : `${51 - idx}周前`,
    }));
  }

  const releaseList = Array.isArray(releases.data) ? releases.data : [];
  const releaseDates = releaseList.map((r) => toDate(r.published_at || r.created_at)).filter(Boolean);
  const lastRelease = releaseDates[0] || null;
  const releasesLastYear = releaseDates.filter((d) => daysBetween(now, d.getTime()) <= 365).length;
  let avgReleaseGapDays = null;
  if (releaseDates.length >= 2) {
    const sorted = [...releaseDates].sort((a, b) => b - a);
    let sum = 0;
    for (let i = 1; i < sorted.length; i++) sum += daysBetween(sorted[i - 1], sorted[i]);
    avgReleaseGapDays = Math.round(sum / (sorted.length - 1));
  }

  // Issue / PR 统计：采样 100 条 + Link 头估算总量
  let issuesPayload = issues.data;
  let issuesTotalApprox = null;
  if (issues.res) issuesTotalApprox = totalFromLink(issues.res);
  const issueSample = Array.isArray(issuesPayload) ? issuesPayload : [];
  const pureIssues = issueSample.filter((i) => !i.pull_request);
  const pullRequests = issueSample.filter((i) => i.pull_request);
  const closedIssues = pureIssues.filter((i) => i.state === 'closed');
  const openIssues = pureIssues.filter((i) => i.state === 'open');

  let avgIssueCloseDays = null;
  const closeDurations = closedIssues
    .map((i) => {
      const c = toDate(i.closed_at);
      const k = toDate(i.created_at);
      return c && k ? daysBetween(c.getTime(), k.getTime()) : null;
    })
    .filter((v) => v !== null && v >= 0);
  if (closeDurations.length) {
    avgIssueCloseDays = Math.round(
      closeDurations.reduce((a, b) => a + b, 0) / closeDurations.length
    );
  }

  const communityData = community.data || null;
  const communityHealth = communityData && typeof communityData.health_percentage === 'number'
    ? communityData.health_percentage
    : null;

  // 工程规范信号：根目录文件清单 + CI 工作流
  const rootEntries = Array.isArray(rootContents.data) ? rootContents.data : [];
  const rootNames = rootEntries.map((e) => e.name).filter(Boolean);
  const lowerNames = rootNames.map((n) => n.toLowerCase());
  const workflowList = Array.isArray(workflows.data) ? workflows.data : [];
  // 纯文档/清单类仓库（如 awesome 列表）不应因「缺测试目录」被扣分
  const DOC_LANGS = new Set([
    'markdown', 'text', 'json', 'yaml', 'xml', 'csv', 'asciidoc',
    'restructuredtext', 'rmarkdown', 'toml', 'ini', 'tsv',
  ]);
  const nativeLanguage = info.language || (languageList[0]?.name ?? null);
  const looksLikeCodeRepo = lowerNames.some((n) =>
    [
      'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod',
      'cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile', 'cmakelists.txt',
    ].includes(n)
  ) || (nativeLanguage ? !DOC_LANGS.has(String(nativeLanguage).toLowerCase()) : false);

  const engineering = {
    rootNames,
    rootFileCount: rootNames.length,
    looksLikeCodeRepo,
    hasCi: workflowList.length > 0,
    workflowCount: workflowList.length,
    workflows: workflowList.slice(0, 6).map((w) => w.name),
    hasTests: rootNames.some((n) => /^(tests?|__tests__|spec|e2e)$/i.test(n)) ||
      // 很多项目（如 monorepo）把用例放在子包里，根目录只留测试配置，这里一并识别
      lowerNames.some((n) => /^(vitest|jest|karma|pytest|cypress|playwright|mocha|ava|jasmine)\.config\./.test(n)) ||
      lowerNames.some((n) => ['pytest.ini', 'tox.ini', '.mocharc.yml', '.mocharc.json', 'codecov.yml'].includes(n)),
    hasDocker: lowerNames.includes('dockerfile') || lowerNames.includes('docker-compose.yml'),
    hasBuildManifest: lowerNames.some((n) =>
      [
        'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod',
        'cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile', 'cmakelists.txt',
      ].includes(n)
    ),
    hasDocsDir: rootNames.some((n) => /^docs?$/i.test(n)),
    hasContributing: lowerNames.some((n) => n.startsWith('contributing')),
    hasChangelog: lowerNames.some((n) => n.startsWith('changelog') || n.startsWith('history')),
    hasLicenseFile: lowerNames.some((n) => n.startsWith('license') || n.startsWith('licence')),
  };

  // 维护状态检测：很多项目没被「归档」，但 README 已声明停止维护/进入维护模式
  const maintenanceStatus = scanMaintenanceStatus(readme.data);

  const createdAt = toDate(info.created_at);
  const ageDays = createdAt ? daysBetween(now, createdAt.getTime()) : null;

  return {
    meta: {
      owner,
      repo,
      fullName: info.full_name,
      url: info.html_url,
      description: info.description || '',
      homepage: info.homepage || '',
      avatar: info.owner?.avatar_url || '',
      ownerType: info.owner?.type || '',
      license: info.license ? info.license.spdx_id || info.license.name : null,
      licenseName: info.license?.name || null,
      defaultBranch: info.default_branch,
      topics: Array.isArray(info.topics) ? info.topics : [],
      archived: Boolean(info.archived),
      disabled: Boolean(info.disabled),
      isFork: Boolean(info.fork),
      isTemplate: Boolean(info.template),
      hasIssues: Boolean(info.has_issues),
      hasWiki: Boolean(info.has_wiki),
      hasPages: Boolean(info.has_pages),
      hasDiscussions: Boolean(info.has_discussions),
      createdAt: info.created_at,
      pushedAt: info.pushed_at,
      updatedAt: info.updated_at,
      ageDays,
      sizeKB: info.size,
      nativeLanguage: info.language || (languageList[0]?.name ?? null),
      readmePresent: Boolean(readme.data && readme.data.name),
      readmeSize: readme.data?.size || 0,
    },
    popularity: {
      stars: info.stargazers_count ?? 0,
      forks: info.forks_count ?? 0,
      watchers: info.subscribers_count ?? info.watchers_count ?? 0,
      network: info.network_count ?? null,
      openIssues: info.open_issues_count ?? 0,
      forkToStarRatio: info.stargazers_count
        ? +((info.forks_count || 0) / info.stargazers_count).toFixed(3)
        : 0,
    },
    activity: {
      lastCommitAt: lastCommit ? lastCommit.toISOString() : null,
      daysSinceLastCommit,
      commitsLast30,
      commitsLast90,
      commitsLast365,
      sampledCommits: commitDates.length,
      weekly,
      latestReleaseAt: lastRelease ? lastRelease.toISOString() : null,
      releasesTotal: releaseList.length,
      releasesLastYear,
      avgReleaseGapDays,
      releaseSample: releaseList.slice(0, 8).map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        prerelease: r.prerelease,
        url: r.html_url,
      })),
      latestVersionTag: releaseList[0]?.tag_name || null,
    },
    community: {
      contributorCount: contributorList.length,
      contributorCountCapped: contributorList.length >= 100,
      topContributors: contributorList.slice(0, 12).map((c) => ({
        login: c.login,
        avatar: c.avatar_url,
        contributions: c.contributions || 0,
        isAnonymous: Boolean(c.anonymous),
      })),
      busFactor: contributorTotal
        ? +((contributorList[0]?.contributions || 0) / contributorTotal).toFixed(3)
        : null,
      top3Share: contributorTotal
        ? +(contributorList.slice(0, 3).reduce((a, c) => a + (c.contributions || 0), 0) /
            contributorTotal).toFixed(3)
        : null,
      communityHealth,
      issueSample: {
        sampled: issueSample.length,
        issues: pureIssues.length,
        pullRequests: pullRequests.length,
        openIssues: openIssues.length,
        closedIssues: closedIssues.length,
        closeRatio: pureIssues.length ? +(closedIssues.length / pureIssues.length).toFixed(3) : null,
        avgIssueCloseDays,
        totalApprox: issuesTotalApprox,
      },
    },
    languages: {
      totalBytes: langTotal,
      list: languageList,
    },
    engineering,
    maintenance: maintenanceStatus,
    diagnostics: {
      // 404 属于「该仓库确实没有这个资源」，不作为异常上报
      failed: [languages, contributors, commits, releases, issues, participation, community, readme]
        .filter((r) => r && r.error && r.status !== 404)
        .map((r) => r.error),
      rateLimit,
      fetchedAt: new Date().toISOString(),
      // 数据来源：直连 api.github.com、经代理，还是经备选中继
      viaRelay: repoRes.viaRelay || null,
      viaProxy: [repoRes, languages, contributors, commits, releases, issues, participation, community, readme]
        .some((r) => r && r.viaProxy),
    },
  };
}

/** 带缓存的分析入口 */
async function analyzeRepo({ owner, repo, token, force }) {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.ts < CACHE_TTL) {
    return { ...hit.payload, diagnostics: { ...hit.payload.diagnostics, cached: true } };
  }
  const payload = await collectRepoMetrics({ owner, repo, token });
  cache.set(key, { ts: Date.now(), payload });
  // 简单容量控制
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return payload;
}

module.exports = {
  analyzeRepo,
  parseRepoInput,
  ghFetch,
  GitHubError,
  cache,
  API_BASE,
  probeConnectivity,
  getConnectivity,
  describeFetchError,
  getProxyStatus,
};
