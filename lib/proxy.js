'use strict';

/**
 * 出网代理支持（零第三方依赖）
 *
 * 为什么需要这个模块：
 *   Node 内置的 fetch（undici）**不会**读取 HTTPS_PROXY / HTTP_PROXY 环境变量，
 *   而 curl / wget / git 都会读。于是出现一个非常容易误判的现象：
 *     - 终端里 curl https://api.github.com 正常
 *     - 同一个环境里本工具却报「无法连接 GitHub API：fetch failed」
 *   本模块让工具真正读懂代理配置，行为与 curl 对齐。
 *
 * 实现方式：自己实现 HTTP CONNECT 隧道 + 在隧道上做 TLS，
 * 全程只用 node:http / node:https / node:tls，不引入任何依赖。
 *
 * 支持的配置（优先级从高到低）：
 *   GITHUB_PROXY / PROXY_URL   本工具专用，显式指定，优先级最高
 *   https_proxy / HTTPS_PROXY  HTTPS 目标
 *   http_proxy  / HTTP_PROXY   HTTP 目标
 *   all_proxy   / ALL_PROXY    兜底
 *   no_proxy    / NO_PROXY     例外名单，支持 example.com、.example.com、example.com:8080、*
 *   代理地址可带凭据：http://user:pass@host:port
 *
 * 安全约定：
 *   - 代理地址中的凭据只用于构造 Proxy-Authorization，绝不出现在日志与诊断输出里；
 *   - 目标服务器的 TLS 证书仍按标准校验（CONNECT 隧道是端到端加密，不因代理而降级）。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');

const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT_MS || 12000);

/**
 * 代理熔断。
 *
 * 现实里存在大量「能连上但用不了」的代理：企业白名单代理、只放行个别路径的
 * 内部代理、已经失效但仍被环境变量指向的代理……对这类代理死心塌地，
 * 结果会比不配代理更糟（明明直连/备用通道能通，却被代理卡住）。
 * 所以这里按「连续失败次数」熔断，到点自动停用一段时间再重试。
 */
const PROXY_FAIL_THRESHOLD = Number(process.env.PROXY_FAIL_THRESHOLD || 3);
const PROXY_SUPPRESS_TTL = Number(process.env.PROXY_SUPPRESS_TTL_MS || 10 * 60 * 1000);

const circuit = {
  failures: 0,
  suppressedUntil: 0,
  reason: null,
  url: null,
};

const HTTPS_KEYS = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];
const HTTP_KEYS = ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];

/** 组装一个带 cause.code 的网络错误，好让上层的 describeFetchError 能翻译成人话 */
function networkError(message, code, extra) {
  const err = new Error(message);
  err.cause = { code };
  if (extra) Object.assign(err, extra);
  return err;
}

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

/** 把 http://host:port、host:port、socks 之类都规整成 URL 对象 */
function normalizeProxyUrl(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null; // socks 暂不支持
  if (!url.port) url.port = url.protocol === 'https:' ? '443' : '80';
  return url;
}

function noProxyList() {
  const raw = process.env.no_proxy || process.env.NO_PROXY || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** NO_PROXY 匹配：支持后缀匹配、可选端口、通配 * */
function isBypassed(host, port) {
  const target = String(host || '').toLowerCase();
  for (const item of noProxyList()) {
    if (item === '*') return true;
    let pattern = item;
    let patternPort = null;
    const colon = pattern.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(pattern.slice(colon + 1))) {
      patternPort = pattern.slice(colon + 1);
      pattern = pattern.slice(0, colon);
    }
    if (patternPort && String(port) !== patternPort) continue;
    const bare = pattern.replace(/^\./, '');
    if (!bare) continue;
    if (target === bare || target.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * 决定某个目标地址该走哪个代理。
 * 返回 null 表示直连（包括「未配置」与「已熔断」两种情况）。
 */
function resolveProxy(targetUrl) {
  let raw = process.env.GITHUB_PROXY || process.env.PROXY_URL || null;
  let source = raw ? 'GITHUB_PROXY' : null;

  if (!raw) {
    const keys = String(targetUrl).startsWith('https:') ? HTTPS_KEYS : HTTP_KEYS;
    for (const key of keys) {
      if (process.env[key]) {
        raw = process.env[key];
        source = key;
        break;
      }
    }
  }

  const parsed = normalizeProxyUrl(raw);
  if (!parsed) return null;

  try {
    const target = new URL(targetUrl);
    const port = target.port || (target.protocol === 'https:' ? '443' : '80');
    if (isBypassed(target.hostname, port)) return null;
  } catch (_) {
    return null;
  }

  // 熔断期内直接当没配代理
  if (circuit.suppressedUntil > Date.now()) return null;

  return { url: parsed, source };
}

/** 代理成功一次就清零失败计数 */
function noteProxySuccess() {
  if (circuit.failures || circuit.suppressedUntil) {
    circuit.failures = 0;
    circuit.suppressedUntil = 0;
    circuit.reason = null;
    circuit.url = null;
  }
}

/** 代理失败累计到阈值就熔断一段时间 */
function noteProxyFailure(proxy, why) {
  circuit.failures += 1;
  if (circuit.failures < PROXY_FAIL_THRESHOLD) return;
  circuit.suppressedUntil = Date.now() + PROXY_SUPPRESS_TTL;
  circuit.reason = why;
  circuit.url = proxy ? maskProxy(proxy.url) : null;
  console.warn(
    `[proxy] 代理 ${circuit.url || '(未知名)'} 连续 ${circuit.failures} 次不可用（${why}），`
    + `已暂时停用 ${Math.round(PROXY_SUPPRESS_TTL / 60000)} 分钟，本段时间内改走直连/备用通道。`
    + ' 如需指定别的代理，请设置 GITHUB_PROXY。'
  );
  circuit.failures = 0;
}

/** 诊断用：熔断状态 */
function getCircuitState() {
  const active = circuit.suppressedUntil > Date.now();
  return {
    suppressed: active,
    until: active ? new Date(circuit.suppressedUntil).toISOString() : null,
    reason: circuit.reason,
    url: circuit.url,
    failures: circuit.failures,
  };
}

/** 打开一条到目标主机的 CONNECT 隧道，返回裸 socket */
function connectViaProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isTlsProxy = proxy.url.protocol === 'https:';
    const mod = isTlsProxy ? https : http;
    const headers = {
      Host: `${host}:${port}`,
      'User-Agent': 'github-health-check/1.0',
      'Proxy-Connection': 'keep-alive',
    };
    if (proxy.url.username || proxy.url.password) {
      const cred = `${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }

    const options = {
      host: proxy.url.hostname,
      port: Number(proxy.url.port) || (isTlsProxy ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    };
    // 公司内网常见自签证书的 https 代理；仅在显式开启时放宽「代理这一跳」的校验
    if (isTlsProxy && process.env.PROXY_INSECURE_TLS === '1') options.rejectUnauthorized = false;

    const req = mod.request(options);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(networkError(`代理服务器拒绝建立隧道（HTTP ${res.statusCode}）`, 'EPROXYCONNECT', { proxyReachable: true }));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      resolve(socket);
    });
    req.setTimeout(timeoutMs, () => {
      fail(networkError(`连接代理超时（超过 ${timeoutMs}ms）`, 'ETIMEDOUT', { proxyUnreachable: true }));
    });
    req.once('error', (err) => {
      // 连代理这一步就失败 → 标记为「代理本身不可用」，上层可以据此回落直连
      const unreachable = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(err.code);
      err.proxyUnreachable = unreachable;
      fail(err);
    });
    req.end();
  });
}

/** 在已建立的隧道上完成 TLS 握手 */
function upgradeTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      servername: host,
      ALPNProtocols: ['http/1.1'],
    });
    const onSecure = () => {
      cleanup();
      resolve(tlsSocket);
    };
    const onError = (err) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      tlsSocket.destroy();
      reject(networkError(`TLS 握手超时（超过 ${timeoutMs}ms）`, 'ETIMEDOUT'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      tlsSocket.removeListener('secureConnect', onSecure);
      tlsSocket.removeListener('error', onError);
    };
    tlsSocket.once('secureConnect', onSecure);
    tlsSocket.once('error', onError);
  });
}

/** 用一个「只复用这一个 socket」的 Agent 发起请求，实现隧道内的 HTTP/1.1 */
function oneShotAgent(socket) {
  const Base = socket.encrypted ? https.Agent : http.Agent;
  class TunnelAgent extends Base {
    createConnection() {
      return socket;
    }
  }
  return new TunnelAgent({ keepAlive: false, maxSockets: 1 });
}

/** 经代理发起一次请求，返回与 fetch Response 兼容的最小子集 */
async function proxiedRequest(targetUrl, { method = 'GET', headers = {}, timeout = PROXY_TIMEOUT, signal, proxy }) {
  if (signal && signal.aborted) throw abortError();

  const target = new URL(targetUrl);
  const isTls = target.protocol === 'https:';
  const port = target.port || (isTls ? '443' : '80');

  let socket = await connectViaProxy(proxy, target.hostname, port, timeout);
  if (signal && signal.aborted) {
    socket.destroy();
    throw abortError();
  }
  if (isTls) socket = await upgradeTls(socket, target.hostname, timeout);

  const res = await new Promise((resolve, reject) => {
    const req = (isTls ? https : http).request({
      hostname: target.hostname,
      port: Number(port),
      path: `${target.pathname}${target.search}`,
      method,
      headers: { ...headers, Host: target.host },
      agent: oneShotAgent(socket),
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      req.destroy(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const done = (fn) => (arg) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };

    req.setTimeout(timeout, () => req.destroy(networkError(`请求超时（超过 ${timeout}ms）`, 'ETIMEDOUT')));

    req.once('response', (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.once('end', done(() => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })));
      response.once('error', done(reject));
    });
    req.once('error', (err) => done(() => reject(aborted ? abortError() : err)));
    req.end();
  });

  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: {
      get: (name) => {
        const value = res.headers[String(name).toLowerCase()];
        return value === undefined ? null : value;
      },
    },
    text: async () => res.body,
    json: async () => JSON.parse(res.body),
    _viaProxy: true,
  };
}

/**
 * 统一的 GET 入口，策略是「代理优先，但两条路都试」：
 *
 *   1. 没配代理        → 直接走内置 fetch（零开销，行为与不支持代理时完全一致）
 *   2. 配了代理且成功   → 用代理的结果
 *   3. 配了代理但失败   → 回落直连再试一次
 *
 * 第 3 条很关键：现实中的代理经常是"能连但不放行某些域名"（企业白名单代理、
 * 带策略的隧道代理都属于这类）。如果死守代理，就会出现「配了代理反而更糟」——
 * 明明直连本来能通。所以这里两个方向都兜住，并把实际生效的那条路打日志说明。
 */
async function httpGet(url, { method = 'GET', headers = {}, timeout = PROXY_TIMEOUT, signal } = {}) {
  const proxy = resolveProxy(url);
  if (!proxy) return fetch(url, { method, headers, signal });

  let viaProxy;
  try {
    viaProxy = await proxiedRequest(url, { method, headers, timeout, signal, proxy });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;

    const why = err?.cause?.code || err?.code || err?.message || '未知错误';
    noteProxyFailure(proxy, why);
    const hint = err.proxyUnreachable ? '代理不可达' : '经代理访问失败';
    console.warn(`[proxy] ${hint}（${why}），回落直连重试`);

    try {
      const res = await fetch(url, { method, headers, signal });
      console.warn('[proxy] 直连成功 —— 本次数据来自直连，代理配置可能不适用于该目标');
      // 把「为什么回落」如实带出去，供 /api/diag、代理自检工具与日志使用，
      // 避免上层把根因笼统描述成「代理不可用」
      try {
        res._proxyFallback = { code: why, reason: err?.message || String(err) };
      } catch (_) { /* Response 若不可扩展则忽略 */ }
      return res;
    } catch (directErr) {
      const directWhy = directErr?.cause?.code || directErr?.code || directErr?.message || '未知错误';
      const combined = new Error(`代理与直连均失败（代理：${why}；直连：${directWhy}）`);
      combined.cause = { code: directErr?.cause?.code || directErr?.code || 'FETCH_FAILED' };
      throw combined;
    }
  }

  noteProxySuccess();
  // 手写的代理客户端不会像原生 fetch 那样自动跟随重定向，这里补齐。
  // 必要性：GitHub 对被重命名过的仓库会回 301（例如 facebook/react 现已迁到 react/react），
  // 不跟随的话，这类仓库在「经代理」时整批失败、直连却完全正常 —— 极难排查。
  return followRedirectsViaProxy(viaProxy, { url, headers, timeout, signal });
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

function withoutAuth(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/^authorization$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 经代理时跟随重定向（最多 5 跳）。
 * 只对代理通道做这件事：直连走原生 fetch，它自己会跟随 ——
 * 这样「配了代理」与「没配代理」才有一致的语义。
 */
async function followRedirectsViaProxy(initial, { url, headers, timeout, signal }) {
  let res = initial;
  let from = url;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS && REDIRECT_CODES.has(res.status); hop++) {
    const location = res.headers.get('location');
    if (!location) break;

    let next;
    try {
      next = new URL(location, from).toString();
    } catch (_) {
      break;
    }

    // 跳到别的主机就摘掉 Authorization，不把凭据交给第三方
    const sameHost = new URL(next).host === new URL(from).host;
    const nextHeaders = sameHost ? headers : withoutAuth(headers);
    // 重定向目标可能命中 NO_PROXY，所以重新解析一次代理
    const nextProxy = resolveProxy(next) || resolveProxy(from);
    if (!nextProxy) break;

    try {
      res = await proxiedRequest(next, { method: 'GET', headers: nextHeaders, timeout, signal, proxy: nextProxy });
      from = next;
    } catch (err) {
      // 跟随失败就保留原始 3xx 响应，让上层如实报错，不隐藏信息
      console.warn(`[proxy] 重定向跟随失败（${next}）：${err?.message || err}`);
      break;
    }
  }
  return res;
}

/** 诊断用：当前会不会走代理、走哪个 */
function getProxyStatus(targetUrl = 'https://api.github.com') {
  const proxy = resolveProxy(targetUrl);
  const circuitState = getCircuitState();
  return {
    configured: Boolean(proxy),
    via: proxy ? proxy.source : null,
    url: proxy ? maskProxy(proxy.url) : null,
    noProxy: noProxyList(),
    target: targetUrl,
    circuit: circuitState,
  };
}

/** 打码，避免把凭据写进日志 / 诊断输出 */
function maskProxy(url) {
  const clone = new URL(url.toString());
  if (clone.username || clone.password) {
    clone.username = '***';
    clone.password = '';
  }
  return clone.toString();
}

module.exports = {
  httpGet,
  resolveProxy,
  getProxyStatus,
  getCircuitState,
  maskProxy,
  proxiedRequest,
  connectViaProxy,
};
