'use strict';

/**
 * 出网诊断
 *
 * 部署到受限环境（云托管容器、公司内网、无外网出口）时，
 * GitHub API 会直接失败，而 Node 的 fetch 只给一句 `fetch failed`。
 * 这个模块负责把「到底哪一步不通」查清楚：
 *   1. DNS 能不能解析 api.github.com
 *   2. 几个关键域名分别能不能连上（含对照组 example.com，用来区分「墙外全不通」还是「只挡 GitHub」）
 *   3. 进程里有没有代理环境变量
 *
 * 全部只做只读请求，不消耗 GitHub 配额（探针走 /rate_limit）。
 */

const dns = require('dns').promises;
const { API_BASE, describeFetchError, getConnectivity, probeConnectivity, getProxyStatus } = require('./github');
const { httpGet } = require('./proxy');
const { probeRelays, isDisabled: relayDisabled, getActiveRelay, penaltyState } = require('./relay');

const TIMEOUT = Number(process.env.DIAG_TIMEOUT_MS || 6000);

/**
 * 判断 DNS 返回的是不是「看起来不该出现的地址」。
 *
 * 这是识别「域名级出网拦截」最有力的线索：
 * 受限环境常把被拦域名解析到保留地址段（例如 198.18.0.0/15，
 * 这是 RFC 2544 的基准测试网段，真实公网 DNS 永远不会返回它），
 * 随后连接被 reset —— 表现为 `fetch failed`，但根因在 DNS 就已经注定了。
 */
const RESERVED_PATTERNS = [
  { re: /^198\.1[89]\./, note: 'RFC 2544 基准测试保留段（198.18.0.0/15）——真实公网 DNS 不会返回，通常是被拦截后回填的地址' },
  { re: /^0\.0\.0\.0$/, note: '未指派地址，通常是拦截后的占位' },
  { re: /^127\./, note: '本机回环地址，说明请求会被导回本机' },
  { re: /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./, note: '内网私有地址（内网出口或分域 DNS 场景下可能正常）' },
  { re: /^169\.254\./, note: '链路本地地址，通常意味着上游没有正常应答' },
];

function inspectAddresses(addresses) {
  for (const ip of addresses) {
    for (const { re, note } of RESERVED_PATTERNS) {
      if (re.test(ip)) return { suspicious: true, ip, note };
    }
  }
  return { suspicious: false, ip: null, note: null };
}

function targets() {
  return [
    {
      id: 'github-api',
      name: 'GitHub API',
      url: `${API_BASE}/rate_limit`,
      critical: true,
      note: '核心数据源（此探针不消耗配额）',
    },
    { id: 'github-web', name: 'GitHub 主站', url: 'https://github.com', critical: false, note: '用于区分 API 单独受限' },
    {
      id: 'github-raw',
      name: 'raw.githubusercontent.com',
      url: 'https://raw.githubusercontent.com',
      critical: false,
      note: 'CDN 域名，用来对比判断拦截粒度',
    },
    {
      id: 'control',
      name: '公共网络对照组',
      url: 'https://example.com',
      critical: false,
      note: '若这里也不通，说明整个环境没有外网出口',
    },
  ];
}

async function probeUrl(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    // 走 httpGet 而不是裸 fetch：探针必须和分析走同一条链路（含代理），
    // 否则会出现「探针说不通、分析却成功」的自相矛盾。
    const res = await httpGet(target.url, {
      headers: { 'User-Agent': 'github-health-check/1.0', Accept: '*/*' },
      timeout: TIMEOUT,
      signal: controller.signal,
    });
    return {
      ...target,
      ok: true,
      status: res.status,
      viaProxy: res._viaProxy === true,
      ms: Date.now() - started,
      error: null,
      code: null,
    };
  } catch (err) {
    const { message, code } = describeFetchError(err, TIMEOUT);
    return { ...target, ok: false, status: null, viaProxy: false, ms: Date.now() - started, error: message, code };
  } finally {
    clearTimeout(timer);
  }
}

/** DNS 解析，带超时保护（某些受限环境会在这里静默挂住） */
async function probeDns(host) {
  const started = Date.now();
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS_TIMEOUT')), TIMEOUT)),
    ]);
    const ips = addresses.map((a) => a.address);
    return {
      host,
      ok: true,
      ms: Date.now() - started,
      addresses: ips,
      error: null,
      inspection: inspectAddresses(ips),
    };
  } catch (err) {
    const timedOut = err.message === 'DNS_TIMEOUT';
    return {
      host,
      ok: false,
      ms: Date.now() - started,
      addresses: [],
      error: timedOut ? `DNS 查询超时（>${TIMEOUT}ms）` : `${err.code || ''} ${err.message}`.trim(),
      inspection: { suspicious: false, ip: null, note: null },
    };
  }
}

function envInfo() {
  const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const proxies = {};
  for (const key of proxyVars) {
    if (process.env[key]) {
      // 只保留主机名，避免把代理凭据写进诊断输出
      proxies[key] = String(process.env[key]).replace(/\/\/[^@/]*@/, '//***@');
    }
  }
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    apiBase: API_BASE,
    githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN),
    proxies,
    // 实际会被使用的代理（含来源变量与 NO_PROXY 判定结果），凭据已打码
    proxyStatus: getProxyStatus(API_BASE),
  };
}

/** 汇总成一句可执行的结论 */
function buildVerdict(probes, dnsResults, relayOk = [], relays = [], proxyStatus = null) {
  const api = probes.find((p) => p.id === 'github-api');
  const control = probes.find((p) => p.id === 'control');
  const anyDnsFail = dnsResults.some((d) => !d.ok);
  const suspectDns = dnsResults.filter((d) => d.inspection?.suspicious);
  const proxyConfigured = Boolean(proxyStatus?.configured);

  const dnsAction = () => suspectDns.map(
    (d) => `DNS 把 ${d.host} 解析到 ${d.inspection.ip}：${d.inspection.note}。`
  );

  if (api.ok) {
    if (api.viaProxy) {
      return {
        level: 'ok',
        summary: `环境通过代理（${proxyStatus.via}）访问 GitHub API，实时体检可用。`,
        actions: [
          `代理地址：${proxyStatus.url}`,
          '注意：Node 内置 fetch 本身不读代理环境变量，本工具是自行接管了 CONNECT 隧道后才生效的；换用其他 Node 程序可能仍会报 fetch failed。',
        ],
      };
    }
    return {
      level: 'ok',
      summary: '环境可正常直连 GitHub API，实时体检可用。',
      actions: [],
    };
  }

  // 直连不通但中继可用 —— 这是受限网络下的正常降级路径
  if (relayOk.length) {
    const actions = [
      '中继通道仅用于公开仓库的只读数据，且不会携带 Token（因此私有仓库不可用）。',
      '若需完全直连：在本机运行（本机通常可直连），或用 GITHUB_API_BASE / GITHUB_RELAY 指向自建网关。',
      '可用 GITHUB_RELAY=off 关闭中继回退，让网络问题直接暴露。',
    ];
    actions.push(...dnsAction());
    if (proxyConfigured) {
      actions.push(`已配置代理（${proxyStatus.via} → ${proxyStatus.url}）但直连探测仍失败，说明代理本身不可用或目标被代理拦截。`);
    } else {
      actions.push('若这台机器有可用代理，设置 HTTPS_PROXY 或 GITHUB_PROXY 后本工具会通过它访问 GitHub（Node 的 fetch 默认不读这些变量，本工具已自行支持）。');
    }
    return {
      level: 'degraded',
      summary: `无法直连 GitHub API（${api.error || '未知原因'}），已自动切换到备用通道「${relayOk[0].name}」。`,
      actions,
    };
  }

  const actions = [];
  if (control.ok) {
    actions.push('当前环境能访问公共网络，但访问不到 GitHub —— 属于针对 GitHub 的域名级出网限制（不是本机没网）。');
  } else {
    actions.push('连公共网络对照组都不通，说明该环境没有外网出口。请在本机运行（本机可正常访问 GitHub API）。');
  }
  actions.push(...dnsAction());
  if (anyDnsFail) {
    actions.push('DNS 解析异常，可尝试改用公共 DNS（如 223.5.5.5 / 8.8.8.8）。');
  }
  const tried = relays.filter((r) => r.error).map((r) => `${r.name}（${r.error}）`).join('、');
  if (tried) actions.push(`已尝试的备用通道均不可用：${tried}`);
  actions.push('临时方案：在本机运行本工具（本机通常可直连 GitHub API）后导出 JSON 报告。');
  if (proxyConfigured) {
    actions.push(`已配置代理（${proxyStatus.via} → ${proxyStatus.url}）但仍不通，说明是代理本身不可用或目标被拦。`);
  } else {
    actions.push('若环境提供 HTTP 代理，请设置 HTTPS_PROXY 或 GITHUB_PROXY（本工具自带代理支持，不需要 NODE_USE_ENV_PROXY）。');
  }

  return {
    level: 'fail',
    summary: `当前环境无法访问 GitHub API：${api.error || '未知原因'}`,
    actions,
  };
}

async function runDiagnostics({ source = 'manual' } = {}) {
  const list = targets();
  const env = envInfo();
  const [probes, dnsResults, connectivity, relays] = await Promise.all([
    Promise.all(list.map(probeUrl)),
    Promise.all([probeDns('api.github.com'), probeDns('github.com')]),
    probeConnectivity({ source }),
    // 诊断报告要的是"每个候选到底能不能用"的完整结论，不能让宽限期提前收工
    relayDisabled() ? Promise.resolve([]) : probeRelays({ force: true, complete: true }),
  ]);

  const apiOk = Boolean(probes.find((p) => p.id === 'github-api')?.ok);
  const relayOk = relays.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);

  return {
    ok: apiOk || relayOk.length > 0,
    directOk: apiOk,
    viaProxy: Boolean(probes.find((p) => p.id === 'github-api')?.viaProxy),
    at: new Date().toISOString(),
    verdict: buildVerdict(probes, dnsResults, relayOk, relays, env.proxyStatus),
    dns: dnsResults,
    probes,
    relays: {
      disabled: relayDisabled(),
      active: getActiveRelay()?.id || relayOk[0]?.id || null,
      usable: relayOk,
      all: relays,
      penalized: penaltyState(),
    },
    connectivity,
    env,
  };
}

/** 人类可读的报告（CLI 与 /api/diag?format=text 共用同一份输出） */
function formatReport(report) {
  const mark = (ok) => (ok ? '[OK]  ' : '[FAIL]');
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('');
  push('GitHub 出网诊断 · /api/diag');
  push('='.repeat(64));

  push('');
  push('DNS 解析');
  for (const d of report.dns) {
    push(`  ${mark(d.ok)} ${d.host}  ->  ${d.ok ? d.addresses.join(', ') : d.error}   (${d.ms}ms)`);
    if (d.inspection?.suspicious) push(`         !! 可疑：${d.inspection.note}`);
  }

  push('');
  push('连通性');
  for (const p of report.probes) {
    const via = p.viaProxy ? '  [经代理]' : '';
    push(`  ${mark(p.ok)} ${p.name}  ->  ${p.ok ? `HTTP ${p.status}` : p.error}   (${p.ms}ms)${via}`);
  }

  push('');
  push('备用通道（中继 / 镜像）');
  if (report.relays.disabled) {
    push('  GITHUB_RELAY=off，已关闭');
  } else {
    for (const r of report.relays.all) {
      push(`  ${mark(r.ok)} ${r.name}  ->  ${r.ok ? `可用 HTTP ${r.status}` : r.error}   (${r.ms}ms)`);
    }
    push(`  当前生效：${report.relays.active || '无（直连可用时不启用）'}`);
    // 降权状态：某个中继在真实业务请求上连续失败过，短期内会被优先跳过。
    // 这一行能解释"探针明明显示可用，为什么当前生效的是别家"。
    const pen = report.relays.penalized || [];
    if (pen.length) {
      push(`  临时降权：${pen.map((p) => `${p.id}（剩余 ${Math.round(p.forMs / 1000)}s）`).join('、')}`);
      push('           探针通过不等于业务可用；降权表示它在真实请求上连续失败，已优先换用其他候选');
    }
  }

  push('');
  push('进程环境');
  push(`  Node        ${report.env.node}  (${report.env.platform})`);
  push(`  API Base    ${report.env.apiBase}`);
  push(`  Token       ${report.env.githubTokenConfigured ? '已配置（5000 次/小时）' : '未配置（60 次/小时）'}`);
  push(`  代理变量    ${Object.keys(report.env.proxies).length ? JSON.stringify(report.env.proxies) : '无'}`);
  const ps = report.env.proxyStatus;
  if (ps) {
    push(`  代理生效    ${ps.configured ? `是 · ${ps.via} → ${ps.url}` : '否（直连）'}`);
    if (ps.noProxy?.length) push(`  NO_PROXY    ${ps.noProxy.join(', ')}`);
  }

  push('');
  push('结论');
  push(`  ${report.verdict.summary}`);
  for (const a of report.verdict.actions) push(`    · ${a}`);

  push('');
  push('原始 JSON：去掉 URL 末尾的 ?format=text 即可看到');
  push('');
  return lines.join('\n');
}

module.exports = { runDiagnostics, formatReport, getConnectivity, probeConnectivity };
