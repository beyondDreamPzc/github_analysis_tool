'use strict';

/**
 * 备选数据通道（relay）
 *
 * 用途：部分部署环境 / 公司内网 / 特定地区会对 github.com 做域名级拦截
 * （DNS 回填保留地址 + 连接重置），此时直连 api.github.com 必然失败。
 * 但只要该环境还有一般外网出口，就可以通过未被拦截的镜像域名取到同样的 REST 数据。
 *
 * 安全约定（重要）：
 *   1. 走中继时**绝不携带 Authorization 头**——Token 不能交给第三方。
 *      因此中继通道只适用于公开仓库，私有仓库必须直连。
 *   2. 中继只用于只读的公开元数据，不涉及任何写入。
 *   3. 使用中继时会在接口返回和页面上明确标注，不伪装成直连数据。
 *
 * 配置：
 *   GITHUB_RELAY=off            关闭中继回退
 *   GITHUB_RELAY=<url 前缀>     使用自建中继，例如 https://my-proxy.example.com/https://api.github.com
 *   未设置时：直连失败后自动在候选列表里挑一个可用的（结果缓存在进程内）
 */

// 注意：这里刻意不 require('./github')，否则会和 github.js 形成循环依赖。
// API_BASE 只从环境变量读取，保持与 github.js 的解析规则一致。
const API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';

const RELAY_TIMEOUT = Number(process.env.RELAY_TIMEOUT_MS || 5000);
const RELAY_TTL = Number(process.env.RELAY_TTL_MS || 30 * 60 * 1000);
// 「一个可用通道都没有」这个负结果缓存得短一些：既避免每个请求都重新探测一轮，
// 又能在通道恢复后较快自愈
const RELAY_NEGATIVE_TTL = Number(process.env.RELAY_NEGATIVE_TTL_MS || 60 * 1000);

/**
 * 候选中继。build(path) 返回可直接 fetch 的完整 URL，path 形如 `/repos/owner/repo`。
 * 只列公开的只读中继/镜像，可用 GITHUB_RELAY 换成自建网关。
 */
const CANDIDATES = [
  {
    id: 'kkgithub',
    name: 'kkgithub 镜像',
    // 该镜像直接映射 api.github.com 的路径结构
    build: (p) => `https://api.kkgithub.com${p}`,
  },
  {
    id: 'ghproxy',
    name: 'gh-proxy 中继',
    build: (p) => `https://gh-proxy.com/https://api.github.com${p}`,
  },
  {
    id: 'gitmirror',
    name: 'gitmirror 中继',
    build: (p) => `https://hub.gitmirror.com/https://api.github.com${p}`,
  },
  {
    id: 'codetabs',
    name: 'codetabs CORS 代理',
    build: (p) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(`https://api.github.com${p}`)}`,
  },
];

const custom = (process.env.GITHUB_RELAY || '').trim();
const DISABLED = custom.toLowerCase() === 'off' || custom.toLowerCase() === '0' || custom === 'false';

/** 自建中继：直接拼前缀 */
const CUSTOM_RELAY = !DISABLED && custom
  ? {
      id: 'custom',
      name: '自建中继（GITHUB_RELAY）',
      build: (p) => `${custom.replace(/\/+$/, '')}${p}`,
    }
  : null;

function candidateList() {
  return CUSTOM_RELAY ? [CUSTOM_RELAY, ...CANDIDATES] : CANDIDATES.slice();
}

let active = null;           // 选中的中继
let activeCheckedAt = 0;
let lastFailure = null;      // 最近一次中继不可用的原因

/**
 * 中继「降权」（penalty）。
 *
 * 现实问题：公共中继会时好时坏。选中的中继若被缓存 30 分钟，
 * 中途它开始 502 时我们只会**原地重试同一个**，一直失败到缓存过期为止——
 * 表现就是"页面时好时坏、偶尔整个 502"。
 *
 * 所以某个中继一旦在真实业务请求上连续失败，就把它降权一段时间，
 * 期间优先选别的候选；候选全被降权时仍然允许用它（避免直接不可用）。
 */
const RELAY_PENALTY_TTL = Number(process.env.RELAY_PENALTY_TTL_MS || 90 * 1000);
const penalties = new Map(); // id -> 失效时间戳

function penalizeRelay(id, ms = RELAY_PENALTY_TTL) {
  if (!id) return;
  penalties.set(id, Date.now() + ms);
}

function isPenalized(id) {
  const until = penalties.get(id);
  if (!until) return false;
  if (Date.now() >= until) { penalties.delete(id); return false; }
  return true;
}

function penaltyState() {
  const now = Date.now();
  return [...penalties.entries()]
    .filter(([, until]) => until > now)
    .map(([id, until]) => ({ id, forMs: until - now }));
}

/** 强制重新探测：中继失效时调用，别让坏选择继续粘住 */
function invalidateActiveRelay() {
  active = null;
  activeCheckedAt = 0;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

/** 判断一个响应看起来是不是"真的 GitHub API 数据" */
async function looksLikeGitHub(res) {
  if (!res.ok) return false;
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object';
  } catch (_) {
    return false;
  }
}

/**
 * 探测单个中继是否可用。
 * 用 /rate_limit 做探针：不消耗 GitHub 配额，且响应结构固定，容易校验真伪。
 */
async function probeRelay(relay) {
  const started = Date.now();
  const { controller, done } = withTimeout(RELAY_TIMEOUT);
  try {
    const res = await fetch(relay.build('/rate_limit'), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'github-health-check/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ...slim(relay), ok: false, status: res.status, ms: Date.now() - started, error: `HTTP ${res.status}` };
    }
    const data = await res.json().catch(() => null);
    const limit = data?.resources?.core?.limit;
    if (typeof limit !== 'number') {
      return { ...slim(relay), ok: false, status: res.status, ms: Date.now() - started, error: '响应不是 GitHub API 结构（可能被中继改写）' };
    }
    return { ...slim(relay), ok: true, status: res.status, ms: Date.now() - started, error: null, rateLimit: data.resources.core };
  } catch (err) {
    const message = err?.name === 'AbortError' ? `超时（>${RELAY_TIMEOUT}ms）` : (err?.cause?.code || err?.message || '请求失败');
    return { ...slim(relay), ok: false, status: null, ms: Date.now() - started, error: String(message) };
  } finally {
    done();
  }
}

const slim = (r) => ({ id: r.id, name: r.name, url: r.build('/rate_limit') });

/**
 * 并行探测所有候选，返回按耗时排序的结果。
 *
 * 并发去重：一次体检会并行打 10 个接口，一旦中继集体失败，
 * 这 10 个请求会同时走到这里——不去重就是 10 轮完整探测（每轮 4 个候选），
 * 既慢又可能把中继直接打挂。in-flight 的探测被复用。
 */
let probeInFlight = null;
// 探测结果的超短缓存：突发场景下（10 路并发同时发现中继坏了）把探测摊薄，
// 避免在同一秒内重复打多轮完整探测。1s 足够吸收突发，又不会让状态变陈旧。
const RELAY_PROBE_MIN_INTERVAL = Number(process.env.RELAY_PROBE_MIN_INTERVAL_MS || 1000);
// 调试/对照用：置 1 可关闭去重，观察"不去重会打出多少轮探测"
const PROBE_DEDUPE = process.env.RELAY_NO_DEDUPE !== '1';
// 已经拿到可用候选后，再等其他候选的宽限期。
// 不加这个的话，一个连不上的候选会把整轮探测拖满 RELAY_TIMEOUT——
// 实测本机上 codetabs 超时 5.0s，比真正可用的 gh-proxy（0.57s）慢近一个数量级，
// 于是"选一个能用的中继"这件事白等 5 秒。有候选可用后最多再等这么久就收工。
const RELAY_PROBE_GRACE = Number(process.env.RELAY_PROBE_GRACE_MS || 400);
let lastProbeAt = 0;
let lastProbeResults = null;

/**
 * 等所有候选落定；但一旦已有候选成功，只再等 graceMs 就返回。
 * complete=true 时退化为 Promise.all（诊断报告需要完整结果）。
 */
function settleWithGrace(list, graceMs, complete) {
  if (complete) return Promise.all(list.map(probeRelay));

  const settled = new Array(list.length).fill(null);
  return new Promise((resolve) => {
    let remaining = list.length;
    let graceTimer = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(settled.map((r, i) => r || {
        ...slim(list[i]), ok: false, status: null, ms: null,
        error: '未在宽限期内返回（已有可用候选，不再等待）',
      }));
    };

    list.forEach(async (relay, i) => {
      try {
        settled[i] = await probeRelay(relay);
      } catch (err) {
        settled[i] = { ...slim(relay), ok: false, status: null, ms: null, error: String(err?.message || err) };
      }
      remaining--;
      if (settled[i].ok && !graceTimer) {
        graceTimer = setTimeout(finish, graceMs);   // 已有可用候选 → 开始宽限倒计时
      }
      if (remaining === 0) finish();
    });
  });
}

async function probeRelays({ force = false, complete = false } = {}) {
  if (PROBE_DEDUPE && !complete) {
    if (!force && lastProbeResults && Date.now() - lastProbeAt < RELAY_PROBE_MIN_INTERVAL) {
      return lastProbeResults;
    }
    if (probeInFlight) return probeInFlight;
  }

  const run = (async () => {
    try {
      const results = await settleWithGrace(candidateList(), RELAY_PROBE_GRACE, complete);
      const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
      lastFailure = ok.length ? null : (results[0]?.error || '无可用中继');
      if (!complete) {
        lastProbeAt = Date.now();
        lastProbeResults = results;
      }
      return results;
    } finally {
      probeInFlight = null;
    }
  })();

  if (PROBE_DEDUPE && !complete) probeInFlight = run;
  return run;
}

/**
 * 选出可用的中继并缓存（正结果缓存 30 分钟，负结果缓存 60 秒）。
 *
 * 选择顺序：未被降权且不在 exclude 里的候选，按探测耗时从快到慢。
 * 若全都被降权，则退而用最快的那个——"可能不稳"好过"完全没有数据"。
 */
async function ensureActiveRelay({ exclude = [] } = {}) {
  if (DISABLED) return null;
  const age = Date.now() - activeCheckedAt;
  if (active && activeCheckedAt && age < RELAY_TTL) return active;
  if (!active && activeCheckedAt && age < RELAY_NEGATIVE_TTL) return null;

  const results = await probeRelays();
  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  const usable = ok.filter((r) => !exclude.includes(r.id) && !isPenalized(r.id));
  const winner = usable[0] || ok.filter((r) => !exclude.includes(r.id))[0] || null;

  active = winner ? (candidateList().find((r) => r.id === winner.id) || null) : null;
  activeCheckedAt = Date.now();
  return active;
}

const getActiveRelay = () => (DISABLED ? null : active);
const isDisabled = () => DISABLED;

module.exports = {
  candidateList,
  probeRelays,
  ensureActiveRelay,
  getActiveRelay,
  isDisabled,
  invalidateActiveRelay,
  penalizeRelay,
  penaltyState,
  slim,
};
