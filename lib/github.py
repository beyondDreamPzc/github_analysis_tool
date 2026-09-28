"""GitHub 数据采集层。

- 零第三方依赖，基于标准库 urllib
- 只调用公开 REST API，不写入任何数据
- 带内存缓存（默认 10 分钟），避免重复消耗配额
"""
import base64
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from .proxy import _do_request, error_code, get_proxy_status, http_get  # noqa: F401
from .score import js_round

API_BASE = os.environ.get('GITHUB_API_BASE') or 'https://api.github.com'
CACHE_TTL = int(os.environ.get('CACHE_TTL_MS') or 10 * 60 * 1000)
REQUEST_TIMEOUT = int(os.environ.get('REQUEST_TIMEOUT_MS') or 15000)
RELAY_ATTEMPTS = int(os.environ.get('RELAY_ATTEMPTS') or 3)
# 同一个请求最多换几个中继候选。公共中继的不稳定是常态，
# 只有真正换候选才能绕开"某个镜像开始抽风"的情况。
RELAY_ROTATIONS = int(os.environ.get('RELAY_ROTATIONS') or 2)
PROBE_TIMEOUT = int(os.environ.get('PROBE_TIMEOUT_MS') or 6000)
DIRECT_BAD_TTL = int(os.environ.get('DIRECT_BAD_TTL_MS') or 5 * 60 * 1000)
# 经中继的并发上限（公共镜像对突发流量敏感）
RELAY_CONCURRENCY = int(os.environ.get('RELAY_CONCURRENCY') or 3)

_UA = 'github-health-check/1.0'


def _now_ms():
    return int(time.time() * 1000)


def _iso(dt=None):
    dt = dt or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + \
        f'{dt.microsecond // 1000:03d}Z'


def _js_round(v):
    """对齐 JavaScript 的 Math.round（.5 向正无穷）"""
    if v is None:
        return None
    return int(math.floor(float(v) + 0.5))


class GitHubError(Exception):
    def __init__(self, message, status=502, detail=None):
        super().__init__(message)
        self.status = status or 502
        self.detail = detail or None
        self.message = message


cache = {}                 # key -> {'ts': int, 'payload': dict}
_cache_lock = threading.Lock()


# ---------------------------------------------------------------- 输入解析

def parse_repo_input(value):
    """从各种输入中解析出 owner / repo，支持完整 URL、git 地址、owner/repo 简写"""
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    raw = re.sub(r'^git\+', '', raw)
    raw = re.sub(r'\.git$', '', raw)
    raw = re.sub(r'/+$', '', raw)

    from_url = re.match(
        r'^(?:https?://)?(?:www\.)?github\.com[/:]([^/]+)/([^/?#]+)', raw, re.I)
    if from_url:
        return _normalize(from_url.group(1), from_url.group(2))

    shorthand = re.match(r'^([\w.-]+)/([\w.-]+)$', raw)
    if shorthand:
        return _normalize(shorthand.group(1), shorthand.group(2))
    return None


def _normalize(owner, repo):
    o = re.sub(r'[^\w.-]', '', owner)
    r = re.sub(r'[^\w.-]', '', re.sub(r'#.*$', '', repo))
    if not o or not r:
        return None
    return {'owner': o, 'repo': r, 'fullName': f'{o}/{r}'}


# ---------------------------------------------------------------- 错误翻译

def describe_fetch_error(err, timeout_ms=None):
    """把底层网络错误翻译成人能看懂的根因。

    裸 socket 层抛出的异常对使用者没有意义（ENOTFOUND / ECONNRESET / …），
    这里统一翻译成中文说明，供错误面板与诊断报告直接展示。
    """
    timeout_ms = timeout_ms or REQUEST_TIMEOUT
    code = error_code(err)
    known = {
        'ENOTFOUND': 'DNS 解析失败：找不到 api.github.com（网络受限或 DNS 被污染）',
        'EAI_AGAIN': 'DNS 解析超时：无法解析 api.github.com',
        'ECONNREFUSED': '连接被拒绝：目标端口不可达（可能被防火墙拦截）',
        'ECONNRESET': '连接被重置：出网请求被拦断（常见于受限的部署环境）',
        'ETIMEDOUT': f'请求 GitHub 超时（超过 {timeout_ms}ms 无响应）',
        'CERT_VERIFY_FAILED': 'TLS 证书校验失败（可能存在中间人代理）',
        'TLS_ERROR': 'TLS 握手失败（证书或协议不兼容）',
        'FETCH_FAILED': f'网络请求失败：{err}',
    }
    if code == 'ETIMEDOUT':
        return {'message': known['ETIMEDOUT'], 'code': 'TIMEOUT'}
    return {'message': known.get(code) or f'网络请求失败：{err}', 'code': code}


def _is_transient(err):
    """是否值得重试的瞬时故障（网络中断 / 上游 5xx），业务错误不重试"""
    if isinstance(err, GitHubError) and (err.detail or {}).get('network'):
        return True
    return getattr(err, 'status', None) in (500, 502, 503, 504)


# ---------------------------------------------------------------- 单次请求

def request_once(url, path, headers, method='GET', raw=False, via_relay_id=None,
                 authenticated=False, timeout=REQUEST_TIMEOUT):
    """单次 HTTP 请求（直连或经中继），负责发请求并把响应翻译成结果 / 异常"""
    try:
        res = http_get(url, method=method, headers=headers, timeout=timeout)
        rate_limit = {
            'remaining': _num(res.headers.get('x-ratelimit-remaining')),
            'limit': _num(res.headers.get('x-ratelimit-limit')),
            'resetAt': _num(res.headers.get('x-ratelimit-reset')),
            'authenticated': bool(authenticated),
        }
        meta = {'path': path, 'viaRelay': via_relay_id or None,
                'viaProxy': res._via_proxy is True}

        if raw:
            return {'res': res, 'rateLimit': rate_limit,
                    'viaRelay': meta['viaRelay'], 'viaProxy': meta['viaProxy']}

        if res.status == 404:
            raise GitHubError('仓库或资源不存在（可能是私有仓库、已删除或拼写错误）', 404, meta)
        if res.status == 401:
            # 401 和 403 是两回事，必须分开说：403 多半是配额或策略，401 是「这串凭据我不认」。
            # 混在一起会让用户往完全错的方向排查 —— 去查网络、去换 IP，而其实该重新生成 Token。
            raise GitHubError(
                'GitHub 拒绝了本次身份验证（401 Bad credentials）。若你配置了 Token，'
                '最常见的原因是它已失效 —— 已过期、被撤销，或复制时带上了多余的空格 / 字符。'
                '可在页面「⚙️ 高级设置」里重新粘贴，或清空它改用匿名配额（60 次/小时）。',
                401, {**meta, 'quotaExhausted': False})
        if res.status in (403, 429):
            reset = (datetime.fromtimestamp(rate_limit['resetAt'], tz=timezone.utc).astimezone()
                     if rate_limit['resetAt'] else None)
            # 经代理时 403 很可能来自代理自身的策略（白名单代理常见），不能一律说成 GitHub 限流
            if meta['viaProxy'] and res.status == 403 and rate_limit['remaining'] != 0:
                raise GitHubError(
                    '请求被代理服务器拒绝（HTTP 403）——部分白名单代理只放行 api.github.com 的个别路径。'
                    '可改用 GITHUB_PROXY 指定另一个代理。',
                    403, {**meta, 'rateLimit': rate_limit})
            # 配额耗尽 ≠ 连不上。这是最容易误判的一类失败：
            # TCP/TLS 全程正常，GitHub 也回了响应，只是回了一句「你这个出口 IP 的匿名额度用完了」。
            # 未认证的 60 次/小时是**按出口 IP 共享**的（家宽 / CGNAT / 公司出口都是一堆人共用），
            # 所以经常出现「刚才还好好的，突然全 403」——不是网络坏了，是隔壁把额度用光了。
            if rate_limit['remaining'] == 0:
                when = ''
                if reset:
                    when = (f'，将于 {reset.year}/{reset.month}/{reset.day} '
                            f'{reset.strftime("%H:%M:%S")} 恢复')
                msg = (f'GitHub 匿名配额已用完（{rate_limit["limit"] or 60} 次/小时，按出口 IP 共享）{when}。'
                       '注意：这是配额问题，不是网络不通（TCP/TLS 均正常）。'
                       '两个办法：① 配置 GITHUB_TOKEN，上限从 60 提升到 5000 次/小时（推荐，根治）；'
                       '② 换一个出口 IP，例如经代理访问（GITHUB_PROXY），会拿到另一份独立额度。')
            else:
                msg = '请求被 GitHub 拒绝（可能触发了限流）'
            raise GitHubError(msg, 429, {**meta, 'rateLimit': rate_limit,
                                         'quotaExhausted': rate_limit['remaining'] == 0})
        if res.status == 202:
            # 统计接口在 GitHub 缓存预热中，返回空数据交由上层重试
            return {'data': None, 'pending': True, 'rateLimit': rate_limit,
                    'viaRelay': meta['viaRelay'], 'viaProxy': meta['viaProxy']}
        if not res.ok:
            detail = None
            try:
                detail = res.json()
            except Exception:
                detail = None
            raise GitHubError(f'GitHub 接口返回 {res.status}', res.status,
                              {**meta, 'detail': detail})

        return {'data': res.json(), 'rateLimit': rate_limit, 'res': res,
                'viaRelay': meta['viaRelay'], 'viaProxy': meta['viaProxy']}
    except GitHubError:
        raise
    except Exception as err:
        info = describe_fetch_error(err)
        # 网络层失败时顺手刷新一次连通性状态，页面上就能直接看到「为什么连不上」
        if info['code'] != 'TIMEOUT':
            threading.Thread(target=lambda: probe_connectivity(source='request-failure'),
                             daemon=True).start()
        raise GitHubError(
            f'无法连接 GitHub API：{info["message"]}',
            504 if info['code'] == 'TIMEOUT' else 502,
            {'path': path, 'code': info['code'], 'network': True,
             'apiBase': API_BASE, 'viaRelay': via_relay_id or None}) from err


def _num(v):
    if v is None or v == '':
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None


# ---------------------------------------------------------------- 中继闸门

_relay_in_flight = 0
_relay_waiters = []
_relay_gate_lock = threading.Lock()


def _with_relay_slot(fn):
    """中继并发闸门。

    体检要打 10 个接口，直连时并行没问题；但公共镜像对突发流量很敏感，
    10 路并发 + 失败重试会在瞬间打出几十个请求，容易被直接限流（表现为整批失败）。
    这里把经中继的请求限制在 3 路并发，其余排队。
    """
    global _relay_in_flight
    with _relay_gate_lock:
        while _relay_in_flight >= RELAY_CONCURRENCY:
            ev = threading.Event()
            _relay_waiters.append(ev)
            _relay_gate_lock.release()
            ev.wait()
            _relay_gate_lock.acquire()
        _relay_in_flight += 1
    try:
        return fn()
    finally:
        with _relay_gate_lock:
            _relay_in_flight -= 1
            if _relay_waiters:
                _relay_waiters.pop(0).set()


# ---------------------------------------------------------------- 带中继回退的 GET

def gh_fetch(path, token=None, method='GET', raw=False, allow_relay=True):
    """带超时、错误归一化、中继回退的 GET。

    三种情形：
      1. 直连正常 → 直连（默认）
      2. 已知直连不可用（探测过且失败）→ 直接走中继，省掉每次请求先等超时的几秒钟
      3. 直连未知 → 先直连，网络层失败或配额耗尽时再自动切中继

    走中继时**不携带 Authorization**，Token 不出本机。
    """
    from . import relay as relay_mod

    auth_token = token or os.environ.get('GITHUB_TOKEN')
    base_headers = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': _UA,
    }
    direct_headers = dict(base_headers)
    if auth_token:
        direct_headers['Authorization'] = f'Bearer {auth_token}'
    direct_url = path if path.startswith('http') else API_BASE + path
    relay_eligible = allow_relay and not relay_mod.is_disabled() and not path.startswith('http')

    def attempt_direct():
        return request_once(direct_url, path, direct_headers, method, raw,
                            None, auth_token)

    def attempt_relay():
        tried = []
        last_err = None

        # 外层：候选轮换。内层：同一个中继的瞬时故障重试。
        # 只有外层轮换才能真正绕开"某个公共中继开始不稳定"的情况——
        # 否则会抱着一个坏中继重试到缓存过期，表现就是页面时好时坏。
        for _round in range(RELAY_ROTATIONS):
            current = relay_mod.get_active_relay()
            if current and (current.id in tried or relay_mod.is_penalized(current.id)):
                current = None
            if current is None:
                try:
                    current = relay_mod.ensure_active_relay(exclude=tried)
                except Exception:
                    current = None
            if current is None:
                break                       # 一个候选都没有
            if current.id in tried:
                break                       # 已无新候选可换

            tried.append(current.id)
            round_err = None
            for attempt in range(1, RELAY_ATTEMPTS + 1):
                try:
                    def call(relay=current):
                        # 关键时点：候选是在"抢到并发槽之前"选定的，而 10 路并发的其余请求
                        # 可能在这段排队时间里已经把该中继判坏了。这里再确认一次，
                        # 避免明知不可用还硬打——否则一次体检会往坏中继上白打几十个请求。
                        if relay_mod.is_penalized(relay.id):
                            raise _relay_penalized_error()
                        return request_once(relay.build(path), path, base_headers, method,
                                            raw, relay.id, False)

                    return _with_relay_slot(call)
                except Exception as err:
                    round_err = last_err = err
                    # 业务错误（404 / 配额 / 仓库不存在）换中继也没用，直接抛出
                    if not _is_transient(err):
                        raise
                    if attempt == RELAY_ATTEMPTS:
                        break
                    # 并发场景下，别的请求可能已经判定这个中继坏了。没必要时别再把无谓的
                    # 重试打到一个已知坏掉的中继上（10 路并发时这点浪费会被放大）。
                    if relay_mod.is_penalized(current.id):
                        print(f'[relay] {current.name} 已被其他请求判定不可用，跳过剩余重试')
                        break
                    print(f'[relay] {current.name} 第 {attempt} 次失败'
                          f'（{getattr(err, "status", None) or (err.detail or {}).get("code")}），重试…')
                    time.sleep(0.4 * attempt + (time.time() % 1) * 0.2)

            # 换个中继继续。降权 + 强制重探，避免坏候选被粘住 30 分钟。
            print(f'[relay] {current.name} 连续失败，降权并切换到下一个候选…')
            relay_mod.penalize_relay(current.id)
            relay_mod.invalidate_active_relay()
            last_err = round_err or last_err

        if last_err:
            raise last_err
        return None                         # 确实没有候选可用

    # 情形 2：已知直连不可用，别让每个请求都白等一次超时
    if relay_eligible and direct_known_bad():
        relay_err = None
        try:
            out = attempt_relay()
            if out:
                return out
        except Exception as err:
            relay_err = err
            print(f'[relay] 本次请求中继失败（{getattr(err, "status", None)}）：{_first_sentence(str(err))}')

        # 直连也可能已经恢复，最后再试一次。两条错误都要保留，
        # 否则用户只会看到"DNS 解析失败"，完全不知道我们试过备用通道。
        try:
            return attempt_direct()
        except Exception as direct_err:
            if relay_err:
                raise GitHubError(
                    _build_dual_failure(direct_err, relay_err),
                    _dual_status(direct_err, relay_err),
                    {'path': path,
                     'code': (direct_err.detail or {}).get('code') or 'RELAY_FAILED',
                     'network': True, 'apiBase': API_BASE, 'relayTried': True}) from direct_err
            raise

    try:
        return attempt_direct()
    except Exception as err:
        # 值得重试的两类失败：网络层不通（域名被拦 / DNS 污染），以及配额耗尽
        retryable = isinstance(err, GitHubError) and (
            (err.detail or {}).get('network') or err.status == 429)
        if not retryable or not relay_eligible:
            raise

        relay_err = None
        try:
            out = attempt_relay()
            if out:
                return out
        except Exception as e:
            relay_err = e

        if relay_err:
            raise GitHubError(
                _build_dual_failure(err, relay_err),
                _dual_status(err, relay_err),
                {'path': path,
                 'code': (err.detail or {}).get('code') or ('QUOTA' if err.status == 429 else None),
                 'network': bool((err.detail or {}).get('network')),
                 'apiBase': API_BASE, 'relayTried': True}) from err

        # 直连失败，且连一个可用的备用通道都没有 —— 这个事实必须说出来
        raise GitHubError(f'{err.message}；且当前未找到可用的备用通道。',
                          err.status or 502,
                          {**(err.detail or {}), 'path': path,
                           'relayUnavailable': True}) from err


def _relay_penalized_error():
    err = GitHubError('中继已被判定不可用', 503)
    err.detail = {'relayPenalized': True, 'network': True}
    return err


def _first_sentence(msg):
    return str(msg or '').split('。')[0]


def _dual_status(err, relay_err):
    if getattr(err, 'status', None) == 429 and getattr(relay_err, 'status', None) == 429:
        return 429
    return 502


def _build_dual_failure(err, relay_err):
    # 两边都是配额耗尽是最常见的组合，单独给一句人话
    if getattr(err, 'status', None) == 429 and getattr(relay_err, 'status', None) == 429:
        return (f'直连与备用通道的 API 配额都已用完（备用通道将于 {_reset_hint(relay_err)} 恢复）。'
                '可配置 GITHUB_TOKEN 把上限从 60 次/小时提升到 5000 次/小时，或稍后重试。')
    relay_reason = re.sub(r'^无法连接 GitHub API：', '', _first_sentence(str(relay_err)))
    return f'直连失败（{_first_sentence(str(err))}）；备用通道也不可用（{relay_reason}）。可稍后重试。'


def _reset_hint(err):
    reset_at = ((err.detail or {}).get('rateLimit') or {}).get('resetAt')
    if not reset_at:
        return '稍后'
    return datetime.fromtimestamp(reset_at).strftime('%H:%M:%S')


def safe_fetch(path, **opts):
    try:
        return gh_fetch(path, **opts)
    except Exception as err:
        return {'data': None, 'error': str(err),
                'status': getattr(err, 'status', None) or 500, 'viaProxy': False}


# ---------------------------------------------------------------- 连通性探测

_connectivity = {
    'ok': None,           # None = 还没探测过
    'checkedAt': None,
    'ms': None,
    'error': None,
    'code': None,
    'source': None,
    'apiBase': API_BASE,
    'rateLimit': None,
}
_conn_lock = threading.Lock()


def probe_connectivity(source='manual', timeout=PROBE_TIMEOUT):
    """探测本进程到 GitHub API 的出网能力。

    用 /rate_limit 做探针——这个接口不消耗 API 配额，可以放心频繁调用。
    """
    started = _now_ms()
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': _UA}
    if os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = f'Bearer {os.environ["GITHUB_TOKEN"]}'
    proxy = get_proxy_status(API_BASE)

    try:
        res = http_get(f'{API_BASE}/rate_limit', headers=headers, timeout=timeout)
        try:
            data = res.json()
        except Exception:
            data = None
        core = ((data or {}).get('resources') or {}).get('core') or None
        result = {
            'ok': res.ok,
            'checkedAt': _iso(),
            'ms': _now_ms() - started,
            'error': None if res.ok else f'GitHub 返回 HTTP {res.status}',
            'code': None if res.ok else f'HTTP_{res.status}',
            'source': source,
            'apiBase': API_BASE,
            'proxy': proxy,
            'rateLimit': {'remaining': core.get('remaining'), 'limit': core.get('limit')} if core else None,
        }
    except Exception as err:
        info = describe_fetch_error(err, timeout)
        result = {
            'ok': False,
            'checkedAt': _iso(),
            'ms': _now_ms() - started,
            'error': info['message'],
            'code': info['code'],
            'source': source,
            'apiBase': API_BASE,
            'proxy': proxy,
            'rateLimit': None,
        }

    with _conn_lock:
        _connectivity.update(result)
    return result


def get_connectivity():
    with _conn_lock:
        return dict(_connectivity)


def direct_known_bad():
    """直连是否处于「已知不可用」状态。

    只认最近的探测结果：超过 TTL 就重新尝试直连，避免网络恢复后还一直走中继。
    """
    conn = get_connectivity()
    if conn['ok'] is not False or not conn['checkedAt']:
        return False
    try:
        checked = datetime.strptime(conn['checkedAt'][:19], '%Y-%m-%dT%H:%M:%S')
        ts = checked.replace(tzinfo=timezone.utc).timestamp() * 1000
    except Exception:
        return False
    return (_now_ms() - ts) < DIRECT_BAD_TTL


# ---------------------------------------------------------------- 维护状态扫描

STALE_KEYWORDS = [
    'deprecated', 'maintenance mode', 'no longer maintained', 'unmaintained',
    'no longer actively', 'not actively maintained', 'no longer being developed',
    'stopped development', 'end of life', 'end-of-life', 'legacy project',
    'sunset', '不再维护', '停止维护', '已废弃', '不再更新',
]


def scan_maintenance_status(readme_data):
    """扫描 README 顶部内容，识别「未归档但已停止维护」的项目状态。

    只看前 3000 字符并对 eol / deprecated 做词边界匹配，尽量避免误伤普通的功能级弃用说明。
    """
    empty = {'declared': False, 'keywords': [], 'excerpt': ''}
    if not readme_data or not readme_data.get('content'):
        return empty

    try:
        text = base64.b64decode(readme_data['content']).decode('utf-8', errors='replace')
    except Exception:
        return empty

    head = text[:3000]
    lower = head.lower()
    matched = []
    first_index = -1

    for kw in STALE_KEYWORDS:
        idx = lower.find(kw)
        if idx != -1:
            matched.append(kw)
            if first_index == -1 or idx < first_index:
                first_index = idx
    m = re.search(r'\beol\b', lower)
    if m:
        matched.append('eol')
        if first_index == -1 or m.start() < first_index:
            first_index = m.start()

    if not matched:
        return empty

    excerpt = text[max(0, first_index - 90):first_index + 190]
    excerpt = re.sub(r'[#>*_\[\]()!`]', ' ', excerpt)
    excerpt = re.sub(r'\s+', ' ', excerpt).strip()
    return {'declared': True, 'keywords': matched, 'excerpt': excerpt}


def total_from_link(res):
    """解析 Link 头，拿到分页总数（最后一页页码 * per_page 是上限估算）"""
    link = res.headers.get('link')
    if not link:
        return None
    m = re.search(r'[?&]page=(\d+)>;\s*rel="last"', link)
    if not m:
        return None
    query = parse_qs(urlparse(res.url).query)
    per_page = int((query.get('per_page') or ['30'])[0])
    return int(m.group(1)) * per_page


def _days_between(a_ms, b_ms):
    return _js_round((a_ms - b_ms) / 86400000)


def _to_ms(value):
    """把 ISO 时间串解析成毫秒时间戳；失败返回 None"""
    if not value:
        return None
    try:
        text = str(value).replace('Z', '+00:00')
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def _to_iso(value):
    ms = _to_ms(value)
    if ms is None:
        return None
    return _iso(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))


# ---------------------------------------------------------------- 指标聚合

DOC_LANGS = {
    'markdown', 'text', 'json', 'yaml', 'xml', 'csv', 'asciidoc',
    'restructuredtext', 'rmarkdown', 'toml', 'ini', 'tsv',
}
BUILD_MANIFESTS = [
    'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod',
    'cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile', 'cmakelists.txt',
]


def collect_repo_metrics(owner, repo, token=None):
    """聚合单个仓库的完整指标"""
    base = f'/repos/{owner}/{repo}'
    now = _now_ms()

    repo_res = gh_fetch(base, token=token)
    info = repo_res['data'] or {}
    rate_limit = repo_res['rateLimit']

    endpoints = [
        f'{base}/languages?per_page=100',
        f'{base}/contributors?per_page=100&anon=1',
        f'{base}/commits?per_page=100',
        f'{base}/releases?per_page=20',
        f'{base}/issues?state=all&per_page=100&sort=created&direction=desc',
        f'{base}/stats/participation',
        f'{base}/community/profile',
        f'{base}/readme',
        f'{base}/contents/',
        f'{base}/contents/.github/workflows?per_page=100',
    ]
    with ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
        fetched = list(pool.map(lambda p: safe_fetch(p, token=token), endpoints))

    (languages, contributors, commits, releases, issues,
     participation, community, readme, root_contents, workflows) = fetched

    # 统计接口首次访问常返回 202，稍等后重试一次
    participation_data = participation.get('data')
    if participation.get('pending'):
        time.sleep(1.8)
        participation_data = safe_fetch(f'{base}/stats/participation', token=token).get('data')

    lang_bytes = languages.get('data') or {}
    lang_total = sum(lang_bytes.values()) if lang_bytes else 0
    language_list = sorted(
        [{'name': name, 'bytes': b,
          'percent': js_round((b / lang_total) * 100, 2) if lang_total else 0}
         for name, b in lang_bytes.items()],
        key=lambda x: -x['bytes'])

    contributor_list = [c for c in (contributors.get('data') or []) if c and c.get('login')] \
        if isinstance(contributors.get('data'), list) else []
    contributor_total = sum(c.get('contributions') or 0 for c in contributor_list)

    commit_list = commits.get('data') if isinstance(commits.get('data'), list) else []
    commit_dates = sorted(
        [ms for ms in (_to_ms((c or {}).get('commit', {}).get('author', {}).get('date'))
                       for c in commit_list) if ms],
        reverse=True)

    last_commit = (commit_dates[0] if commit_dates
                   else _to_ms(info.get('pushed_at')) or _to_ms(info.get('updated_at')))
    days_since_last_commit = _days_between(now, last_commit) if last_commit else None
    commits_last_30 = len([d for d in commit_dates if _days_between(now, d) <= 30])
    commits_last_90 = len([d for d in commit_dates if _days_between(now, d) <= 90])
    commits_last_365 = len([d for d in commit_dates if _days_between(now, d) <= 365])

    # 周提交序列（优先用官方 participation，缺失则用提交样本按周聚合）
    if participation_data and isinstance(participation_data.get('all'), list):
        all_weeks = participation_data['all']
        weekly = [{'weeksAgo': len(all_weeks) - 1 - idx, 'count': count,
                   'label': '本周' if len(all_weeks) - 1 - idx == 0 else f'{len(all_weeks) - 1 - idx}周前'}
                  for idx, count in enumerate(all_weeks)]
    else:
        buckets = [0] * 52
        for d in commit_dates:
            w = int(_days_between(now, d) // 7)
            if 0 <= w < 52:
                buckets[51 - w] += 1
        weekly = [{'weeksAgo': 51 - idx, 'count': count,
                   'label': '本周' if idx == 51 else f'{51 - idx}周前'}
                  for idx, count in enumerate(buckets)]

    release_list = releases.get('data') if isinstance(releases.get('data'), list) else []
    release_dates = sorted(
        [ms for ms in (_to_ms(r.get('published_at') or r.get('created_at')) for r in release_list) if ms],
        reverse=True)
    last_release = release_dates[0] if release_dates else None
    releases_last_year = len([d for d in release_dates if _days_between(now, d) <= 365])
    avg_release_gap_days = None
    if len(release_dates) >= 2:
        total_gap = sum(_days_between(release_dates[i - 1], release_dates[i])
                        for i in range(1, len(release_dates)))
        avg_release_gap_days = _js_round(total_gap / (len(release_dates) - 1))

    # Issue / PR 统计：采样 100 条 + Link 头估算总量
    issues_payload = issues.get('data')
    issues_total_approx = total_from_link(issues['res']) if issues.get('res') else None
    issue_sample = issues_payload if isinstance(issues_payload, list) else []
    pure_issues = [i for i in issue_sample if not i.get('pull_request')]
    pull_requests = [i for i in issue_sample if i.get('pull_request')]
    closed_issues = [i for i in pure_issues if i.get('state') == 'closed']
    open_issues = [i for i in pure_issues if i.get('state') == 'open']

    close_durations = []
    for i in closed_issues:
        c, k = _to_ms(i.get('closed_at')), _to_ms(i.get('created_at'))
        if c and k:
            d = _days_between(c, k)
            if d >= 0:
                close_durations.append(d)
    avg_issue_close_days = (_js_round(sum(close_durations) / len(close_durations))
                            if close_durations else None)

    community_data = community.get('data') or None
    community_health = (community_data.get('health_percentage')
                        if isinstance(community_data, dict)
                        and isinstance(community_data.get('health_percentage'), (int, float))
                        else None)

    # 工程规范信号：根目录文件清单 + CI 工作流
    root_entries = root_contents.get('data') if isinstance(root_contents.get('data'), list) else []
    root_names = [e.get('name') for e in root_entries if e.get('name')]
    lower_names = [n.lower() for n in root_names]
    workflow_list = workflows.get('data') if isinstance(workflows.get('data'), list) else []
    # 纯文档/清单类仓库（如 awesome 列表）不应因「缺测试目录」被扣分
    native_language = info.get('language') or (language_list[0]['name'] if language_list else None)
    looks_like_code_repo = any(n in BUILD_MANIFESTS for n in lower_names) or (
        bool(native_language) and str(native_language).lower() not in DOC_LANGS)

    engineering = {
        'rootNames': root_names,
        'rootFileCount': len(root_names),
        'looksLikeCodeRepo': looks_like_code_repo,
        'hasCi': len(workflow_list) > 0,
        'workflowCount': len(workflow_list),
        'workflows': [w.get('name') for w in workflow_list[:6]],
        'hasTests': any(re.match(r'^(tests?|__tests__|spec|e2e)$', n, re.I) for n in root_names)
        # 很多项目（如 monorepo）把用例放在子包里，根目录只留测试配置，这里一并识别
        or any(re.match(r'^(vitest|jest|karma|pytest|cypress|playwright|mocha|ava|jasmine)\.config\.', n)
               for n in lower_names)
        or any(n in ('pytest.ini', 'tox.ini', '.mocharc.yml', '.mocharc.json', 'codecov.yml')
               for n in lower_names),
        'hasDocker': 'dockerfile' in lower_names or 'docker-compose.yml' in lower_names,
        'hasBuildManifest': any(n in BUILD_MANIFESTS for n in lower_names),
        'hasDocsDir': any(re.match(r'^docs?$', n, re.I) for n in root_names),
        'hasContributing': any(n.startswith('contributing') for n in lower_names),
        'hasChangelog': any(n.startswith('changelog') or n.startswith('history') for n in lower_names),
        'hasLicenseFile': any(n.startswith('license') or n.startswith('licence') for n in lower_names),
    }

    # 维护状态检测：很多项目没被「归档」，但 README 已声明停止维护/进入维护模式
    maintenance_status = scan_maintenance_status(readme.get('data'))

    created_at = _to_ms(info.get('created_at'))
    age_days = _days_between(now, created_at) if created_at else None
    owner_info = info.get('owner') or {}
    license_info = info.get('license')
    stars = info.get('stargazers_count') or 0
    forks = info.get('forks_count') or 0

    return {
        'meta': {
            'owner': owner,
            'repo': repo,
            'fullName': info.get('full_name'),
            'url': info.get('html_url'),
            'description': info.get('description') or '',
            'homepage': info.get('homepage') or '',
            'avatar': owner_info.get('avatar_url') or '',
            'ownerType': owner_info.get('type') or '',
            'license': (license_info.get('spdx_id') or license_info.get('name')) if license_info else None,
            'licenseName': (license_info or {}).get('name') or None,
            'defaultBranch': info.get('default_branch'),
            'topics': info.get('topics') if isinstance(info.get('topics'), list) else [],
            'archived': bool(info.get('archived')),
            'disabled': bool(info.get('disabled')),
            'isFork': bool(info.get('fork')),
            'isTemplate': bool(info.get('template')),
            'hasIssues': bool(info.get('has_issues')),
            'hasWiki': bool(info.get('has_wiki')),
            'hasPages': bool(info.get('has_pages')),
            'hasDiscussions': bool(info.get('has_discussions')),
            'createdAt': info.get('created_at'),
            'pushedAt': info.get('pushed_at'),
            'updatedAt': info.get('updated_at'),
            'ageDays': age_days,
            'sizeKB': info.get('size'),
            'nativeLanguage': info.get('language') or (language_list[0]['name'] if language_list else None),
            'readmePresent': bool(readme.get('data') and readme['data'].get('name')),
            'readmeSize': (readme.get('data') or {}).get('size') or 0,
        },
        'popularity': {
            'stars': stars,
            'forks': forks,
            'watchers': info.get('subscribers_count') or info.get('watchers_count') or 0,
            'network': info.get('network_count'),
            'openIssues': info.get('open_issues_count') or 0,
            'forkToStarRatio': js_round(forks / stars, 3) if stars else 0,
        },
        'activity': {
            'lastCommitAt': _iso(datetime.fromtimestamp(last_commit / 1000, tz=timezone.utc))
            if last_commit else None,
            'daysSinceLastCommit': days_since_last_commit,
            'commitsLast30': commits_last_30,
            'commitsLast90': commits_last_90,
            'commitsLast365': commits_last_365,
            'sampledCommits': len(commit_dates),
            'weekly': weekly,
            'latestReleaseAt': _iso(datetime.fromtimestamp(last_release / 1000, tz=timezone.utc))
            if last_release else None,
            'releasesTotal': len(release_list),
            'releasesLastYear': releases_last_year,
            'avgReleaseGapDays': avg_release_gap_days,
            'releaseSample': [{
                'tag': r.get('tag_name'),
                'name': r.get('name') or r.get('tag_name'),
                'publishedAt': r.get('published_at'),
                'prerelease': r.get('prerelease'),
                'url': r.get('html_url'),
            } for r in release_list[:8]],
            'latestVersionTag': (release_list[0].get('tag_name') if release_list else None),
        },
        'community': {
            'contributorCount': len(contributor_list),
            'contributorCountCapped': len(contributor_list) >= 100,
            'topContributors': [{
                'login': c.get('login'),
                'avatar': c.get('avatar_url'),
                'contributions': c.get('contributions') or 0,
                'isAnonymous': bool(c.get('anonymous')),
            } for c in contributor_list[:12]],
            'busFactor': js_round((contributor_list[0].get('contributions') or 0) / contributor_total, 3)
            if contributor_total else None,
            'top3Share': js_round(sum(c.get('contributions') or 0 for c in contributor_list[:3])
                                / contributor_total, 3) if contributor_total else None,
            'communityHealth': community_health,
            'issueSample': {
                'sampled': len(issue_sample),
                'issues': len(pure_issues),
                'pullRequests': len(pull_requests),
                'openIssues': len(open_issues),
                'closedIssues': len(closed_issues),
                'closeRatio': js_round(len(closed_issues) / len(pure_issues), 3) if pure_issues else None,
                'avgIssueCloseDays': avg_issue_close_days,
                'totalApprox': issues_total_approx,
            },
        },
        'languages': {'totalBytes': lang_total, 'list': language_list},
        'engineering': engineering,
        'maintenance': maintenance_status,
        'diagnostics': {
            # 404 属于「该仓库确实没有这个资源」，不作为异常上报
            'failed': [r['error'] for r in
                       (languages, contributors, commits, releases, issues,
                        participation, community, readme)
                       if r and r.get('error') and r.get('status') != 404],
            'rateLimit': rate_limit,
            'fetchedAt': _iso(),
            # 数据来源：直连 api.github.com、经代理，还是经备选中继
            'viaRelay': repo_res.get('viaRelay') or None,
            'viaProxy': any(r.get('viaProxy') for r in
                            (repo_res, languages, contributors, commits, releases, issues,
                             participation, community, readme) if r),
        },
    }


def analyze_repo(owner, repo, token=None, force=False):
    """带缓存的分析入口"""
    key = f'{owner}/{repo}'.lower()
    with _cache_lock:
        hit = cache.get(key)
    if not force and hit and (_now_ms() - hit['ts']) < CACHE_TTL:
        payload = dict(hit['payload'])
        payload['diagnostics'] = {**payload['diagnostics'], 'cached': True}
        return payload

    payload = collect_repo_metrics(owner, repo, token)
    with _cache_lock:
        cache[key] = {'ts': _now_ms(), 'payload': payload}
        # 简单容量控制
        if len(cache) > 200:
            oldest = min(cache.items(), key=lambda kv: kv[1]['ts'])[0]
            cache.pop(oldest, None)
    return payload
