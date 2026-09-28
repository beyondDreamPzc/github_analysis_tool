"""出网诊断。

部署到受限环境（云托管容器、公司内网、无外网出口）时，
GitHub API 会直接失败，而底层只会给一句含糊的网络错误。
这个模块负责把「到底哪一步不通」查清楚：
  1. DNS 能不能解析 api.github.com
  2. 几个关键域名分别能不能连上（含对照组 example.com，用来区分「墙外全不通」还是「只挡 GitHub」）
  3. 进程里有没有代理环境变量

全部只做只读请求，不消耗 GitHub 配额（探针走 /rate_limit）。
"""
import platform
import re
import socket
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .github import (API_BASE, describe_fetch_error, get_connectivity,
                     probe_connectivity)
from .proxy import http_get, get_proxy_status
from .relay import get_active_relay, is_disabled as relay_disabled, penalty_state, probe_relays

TIMEOUT = int(__import__('os').environ.get('DIAG_TIMEOUT_MS') or 6000)


def _iso():
    dt = datetime.now(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def _now_ms():
    return int(time.time() * 1000)


# 判断 DNS 返回的是不是「看起来不该出现的地址」。
#
# 这是识别「域名级出网拦截」最有力的线索：
# 受限环境常把被拦域名解析到保留地址段（例如 198.18.0.0/15，
# 这是 RFC 2544 的基准测试网段，真实公网 DNS 永远不会返回它），
# 随后连接被 reset —— 表现为网络错误，但根因在 DNS 就已经注定了。
RESERVED_PATTERNS = [
    (re.compile(r'^198\.1[89]\.'),
     'RFC 2544 基准测试保留段（198.18.0.0/15）——真实公网 DNS 不会返回，通常是被拦截后回填的地址'),
    (re.compile(r'^0\.0\.0\.0$'), '未指派地址，通常是拦截后的占位'),
    (re.compile(r'^127\.'), '本机回环地址，说明请求会被导回本机'),
    (re.compile(r'^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.'),
     '内网私有地址（内网出口或分域 DNS 场景下可能正常）'),
    (re.compile(r'^169\.254\.'), '链路本地地址，通常意味着上游没有正常应答'),
]


def inspect_addresses(addresses):
    for ip in addresses:
        for pattern, note in RESERVED_PATTERNS:
            if pattern.search(ip):
                return {'suspicious': True, 'ip': ip, 'note': note}
    return {'suspicious': False, 'ip': None, 'note': None}


def targets():
    return [
        {'id': 'github-api', 'name': 'GitHub API', 'url': f'{API_BASE}/rate_limit',
         'critical': True, 'note': '核心数据源（此探针不消耗配额）'},
        {'id': 'github-web', 'name': 'GitHub 主站', 'url': 'https://github.com',
         'critical': False, 'note': '用于区分 API 单独受限'},
        {'id': 'github-raw', 'name': 'raw.githubusercontent.com',
         'url': 'https://raw.githubusercontent.com', 'critical': False,
         'note': 'CDN 域名，用来对比判断拦截粒度'},
        {'id': 'control', 'name': '公共网络对照组', 'url': 'https://example.com',
         'critical': False, 'note': '若这里也不通，说明整个环境没有外网出口'},
    ]


def probe_url(target):
    started = _now_ms()
    try:
        # 走 http_get 而不是裸请求：探针必须和分析走同一条链路（含代理），
        # 否则会出现「探针说不通、分析却成功」的自相矛盾。
        res = http_get(target['url'],
                       headers={'User-Agent': 'github-health-check/1.0', 'Accept': '*/*'},
                       timeout=TIMEOUT)
        return {**target, 'ok': True, 'status': res.status,
                'viaProxy': res._via_proxy is True, 'ms': _now_ms() - started,
                'error': None, 'code': None}
    except Exception as err:
        info = describe_fetch_error(err, TIMEOUT)
        return {**target, 'ok': False, 'status': None, 'viaProxy': False,
                'ms': _now_ms() - started, 'error': info['message'], 'code': info['code']}


def probe_dns(host):
    """DNS 解析，带超时保护（某些受限环境会在这里静默挂住）"""
    started = _now_ms()
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(lambda: socket.getaddrinfo(host, None))
        infos = future.result(timeout=TIMEOUT / 1000.0)
        ips = []
        for info in infos:
            addr = info[4][0]
            if addr not in ips:
                ips.append(addr)
        return {'host': host, 'ok': True, 'ms': _now_ms() - started,
                'addresses': ips, 'error': None, 'inspection': inspect_addresses(ips)}
    except Exception as err:
        timed_out = isinstance(err, TimeoutError) or 'timed out' in str(err).lower()
        message = f'DNS 查询超时（>{TIMEOUT}ms）' if timed_out else str(err)
        return {'host': host, 'ok': False, 'ms': _now_ms() - started,
                'addresses': [], 'error': message,
                'inspection': {'suspicious': False, 'ip': None, 'note': None}}
    finally:
        pool.shutdown(wait=False)


def env_info():
    proxy_vars = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy',
                  'http_proxy', 'NO_PROXY', 'no_proxy']
    proxies = {}
    env = __import__('os').environ
    for key in proxy_vars:
        if env.get(key):
            # 只保留主机名，避免把代理凭据写进诊断输出
            proxies[key] = re.sub(r'//[^@/]*@', '//***@', str(env[key]))
    return {
        'runtime': f'Python {sys.version.split()[0]}',
        'platform': f'{platform.system().lower()} {platform.machine()}',
        'apiBase': API_BASE,
        'githubTokenConfigured': bool(env.get('GITHUB_TOKEN')),
        'proxies': proxies,
        # 实际会被使用的代理（含来源变量与 NO_PROXY 判定结果），凭据已打码
        'proxyStatus': get_proxy_status(API_BASE),
    }


def build_verdict(probes, dns_results, relay_ok=None, relays=None, proxy_status=None):
    """汇总成一句可执行的结论"""
    relay_ok = relay_ok or []
    relays = relays or []
    api = next((p for p in probes if p['id'] == 'github-api'), None)
    control = next((p for p in probes if p['id'] == 'control'), None)
    any_dns_fail = any(not d['ok'] for d in dns_results)
    suspect_dns = [d for d in dns_results if (d.get('inspection') or {}).get('suspicious')]
    proxy_configured = bool((proxy_status or {}).get('configured'))

    def dns_action():
        return [f"DNS 把 {d['host']} 解析到 {d['inspection']['ip']}：{d['inspection']['note']}。"
                for d in suspect_dns]

    if api and api['ok']:
        if api.get('viaProxy'):
            return {
                'level': 'ok',
                'summary': f"环境通过代理（{proxy_status['via']}）访问 GitHub API，实时体检可用。",
                'actions': [
                    f"代理地址：{proxy_status['url']}",
                    '注意：本工具会优先使用 GITHUB_PROXY，其次才是通用代理环境变量；'
                    '若想确认最终生效的是哪一条，看这里即可。',
                ],
            }
        return {'level': 'ok', 'summary': '环境可正常直连 GitHub API，实时体检可用。', 'actions': []}

    # 直连不通但中继可用 —— 这是受限网络下的正常降级路径
    if relay_ok:
        actions = [
            '中继通道仅用于公开仓库的只读数据，且不会携带 Token（因此私有仓库不可用）。',
            '若需完全直连：在本机运行（本机通常可直连），或用 GITHUB_API_BASE / GITHUB_RELAY 指向自建网关。',
            '可用 GITHUB_RELAY=off 关闭中继回退，让网络问题直接暴露。',
        ]
        actions += dns_action()
        if proxy_configured:
            actions.append(
                f"已配置代理（{proxy_status['via']} → {proxy_status['url']}）但直连探测仍失败，"
                '说明代理本身不可用或目标被代理拦截。')
        else:
            actions.append('若这台机器有可用代理，设置 HTTPS_PROXY 或 GITHUB_PROXY 后本工具会通过它访问 GitHub。')
        return {
            'level': 'degraded',
            'summary': f"无法直连 GitHub API（{(api or {}).get('error') or '未知原因'}），"
                       f"已自动切换到备用通道「{relay_ok[0]['name']}」。",
            'actions': actions,
        }

    actions = []
    if control and control['ok']:
        actions.append('当前环境能访问公共网络，但访问不到 GitHub —— 属于针对 GitHub 的域名级出网限制（不是本机没网）。')
    else:
        actions.append('连公共网络对照组都不通，说明该环境没有外网出口。请在本机运行（本机可正常访问 GitHub API）。')
    actions += dns_action()
    if any_dns_fail:
        actions.append('DNS 解析异常，可尝试改用公共 DNS（如 223.5.5.5 / 8.8.8.8）。')
    tried = '、'.join(f"{r['name']}（{r['error']}）" for r in relays if r.get('error'))
    if tried:
        actions.append(f'已尝试的备用通道均不可用：{tried}')
    actions.append('临时方案：在本机运行本工具（本机通常可直连 GitHub API）后导出 JSON 报告。')
    if proxy_configured:
        actions.append(f"已配置代理（{proxy_status['via']} → {proxy_status['url']}）但仍不通，"
                       '说明是代理本身不可用或目标被拦。')
    else:
        actions.append('若环境提供 HTTP 代理，请设置 HTTPS_PROXY 或 GITHUB_PROXY。')

    return {
        'level': 'fail',
        'summary': f"当前环境无法访问 GitHub API：{(api or {}).get('error') or '未知原因'}",
        'actions': actions,
    }


def run_diagnostics(source='manual'):
    targets_list = targets()
    env = env_info()

    with ThreadPoolExecutor(max_workers=len(targets_list)) as pool:
        probes = list(pool.map(probe_url, targets_list))
    with ThreadPoolExecutor(max_workers=2) as pool:
        dns_results = list(pool.map(probe_dns, ['api.github.com', 'github.com']))
    connectivity = probe_connectivity(source=source)
    # 诊断报告要的是"每个候选到底能不能用"的完整结论，不能让宽限期提前收工
    relays = [] if relay_disabled() else probe_relays(force=True, complete=True)

    api_ok = bool(next((p for p in probes if p['id'] == 'github-api' and p['ok']), None))
    relay_ok = sorted([r for r in relays if r['ok']], key=lambda r: r['ms'])
    active = get_active_relay()

    return {
        'ok': api_ok or len(relay_ok) > 0,
        'directOk': api_ok,
        'viaProxy': bool(next((p for p in probes if p['id'] == 'github-api' and p.get('viaProxy')), None)),
        'at': _iso(),
        'verdict': build_verdict(probes, dns_results, relay_ok, relays, env['proxyStatus']),
        'dns': dns_results,
        'probes': probes,
        'relays': {
            'disabled': relay_disabled(),
            'active': (active.id if active else None) or (relay_ok[0]['id'] if relay_ok else None),
            'usable': relay_ok,
            'all': relays,
            'penalized': penalty_state(),
        },
        'connectivity': connectivity,
        'env': env,
    }


def format_report(report):
    """人类可读的报告（/api/diag?format=text 使用）"""
    mark = lambda ok: '[OK]  ' if ok else '[FAIL]'          # noqa: E731
    lines = []

    def push(s=''):
        lines.append(s)

    push('')
    push('GitHub 出网诊断 · /api/diag')
    push('=' * 64)

    push('')
    push('DNS 解析')
    for d in report['dns']:
        shown = ', '.join(d['addresses']) if d['ok'] else d['error']
        push(f"  {mark(d['ok'])} {d['host']}  ->  {shown}   ({d['ms']}ms)")
        if (d.get('inspection') or {}).get('suspicious'):
            push(f"         !! 可疑：{d['inspection']['note']}")

    push('')
    push('连通性')
    for p in report['probes']:
        via = '  [经代理]' if p.get('viaProxy') else ''
        shown = f"HTTP {p['status']}" if p['ok'] else p['error']
        push(f"  {mark(p['ok'])} {p['name']}  ->  {shown}   ({p['ms']}ms){via}")

    push('')
    push('备用通道（中继 / 镜像）')
    if report['relays']['disabled']:
        push('  GITHUB_RELAY=off，已关闭')
    else:
        for r in report['relays']['all']:
            shown = f"可用 HTTP {r['status']}" if r['ok'] else r['error']
            push(f"  {mark(r['ok'])} {r['name']}  ->  {shown}   ({r['ms']}ms)")
        push(f"  当前生效：{report['relays']['active'] or '无（直连可用时不启用）'}")
        # 降权状态：某个中继在真实业务请求上连续失败过，短期内会被优先跳过。
        # 这一行能解释"探针明明显示可用，为什么当前生效的是别家"。
        penalized = report['relays'].get('penalized') or []
        if penalized:
            joined = '、'.join(f"{p['id']}（剩余 {round(p['forMs'] / 1000)}s）" for p in penalized)
            push(f'  临时降权：{joined}')
            push('           探针通过不等于业务可用；降权表示它在真实请求上连续失败，已优先换用其他候选')

    push('')
    push('进程环境')
    push(f"  Runtime     {report['env']['runtime']}  ({report['env']['platform']})")
    push(f"  API Base    {report['env']['apiBase']}")
    push(f"  Token       {'已配置（5000 次/小时）' if report['env']['githubTokenConfigured'] else '未配置（60 次/小时）'}")
    proxies = report['env']['proxies']
    push(f"  代理变量    {_json_dumps(proxies) if proxies else '无'}")
    ps = report['env'].get('proxyStatus')
    if ps:
        if ps['configured']:
            push(f"  代理生效    是 · {ps['via']} → {ps['url']}")
        else:
            push('  代理生效    否（直连）')
        if ps.get('noProxy'):
            push(f"  NO_PROXY    {', '.join(ps['noProxy'])}")

    push('')
    push('结论')
    push(f"  {report['verdict']['summary']}")
    for a in report['verdict']['actions']:
        push(f'    · {a}')

    push('')
    push('原始 JSON：去掉 URL 末尾的 ?format=text 即可看到')
    push('')
    return '\n'.join(lines)


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False)
