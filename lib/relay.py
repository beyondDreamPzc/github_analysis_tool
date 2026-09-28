"""备选数据通道（relay）。

用途：部分部署环境 / 公司内网 / 特定地区会对 github.com 做域名级拦截
（DNS 回填保留地址 + 连接重置），此时直连 api.github.com 必然失败。
但只要该环境还有一般外网出口，就可以通过未被拦截的镜像域名取到同样的 REST 数据。

安全约定（重要）：
  1. 走中继时**绝不携带 Authorization 头**——Token 不能交给第三方。
     因此中继通道只适用于公开仓库，私有仓库必须直连。
  2. 中继只用于只读的公开元数据，不涉及任何写入。
  3. 使用中继时会在接口返回和页面上明确标注，不伪装成直连数据。

配置：
  GITHUB_RELAY=off            关闭中继回退
  GITHUB_RELAY=<url 前缀>     使用自建中继，例如 https://my-proxy.example.com/https://api.github.com
  未设置时：直连失败后自动在候选列表里挑一个可用的（结果缓存在进程内）
"""
import os
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from urllib.parse import quote

from .proxy import HttpResponse, NetworkError, _do_request, error_code

# 注意：这里刻意不 import .github，否则会和 github.py 形成循环依赖。
# API_BASE 只从环境变量读取，保持与 github.py 的解析规则一致。
API_BASE = os.environ.get('GITHUB_API_BASE') or 'https://api.github.com'

RELAY_TIMEOUT = int(os.environ.get('RELAY_TIMEOUT_MS') or 5000)
RELAY_TTL = int(os.environ.get('RELAY_TTL_MS') or 30 * 60 * 1000)
# 「一个可用通道都没有」这个负结果缓存得短一些：既避免每个请求都重新探测一轮，
# 又能在通道恢复后较快自愈
RELAY_NEGATIVE_TTL = int(os.environ.get('RELAY_NEGATIVE_TTL_MS') or 60 * 1000)

_UA = 'github-health-check/1.0'


class _Relay:
    """候选中继。build(path) 返回可直接请求的完整 URL。"""

    def __init__(self, rid, name, builder):
        self.id = rid
        self.name = name
        self._builder = builder

    def build(self, path):
        return self._builder(path)


CANDIDATES = [
    # 该镜像直接映射 api.github.com 的路径结构
    _Relay('kkgithub', 'kkgithub 镜像', lambda p: f'https://api.kkgithub.com{p}'),
    _Relay('ghproxy', 'gh-proxy 中继', lambda p: f'https://gh-proxy.com/https://api.github.com{p}'),
    _Relay('gitmirror', 'gitmirror 中继', lambda p: f'https://hub.gitmirror.com/https://api.github.com{p}'),
    _Relay('codetabs', 'codetabs CORS 代理',
           lambda p: f'https://api.codetabs.com/v1/proxy?quest={quote(f"https://api.github.com{p}", safe="")}'),
]

_custom = (os.environ.get('GITHUB_RELAY') or '').strip()
DISABLED = _custom.lower() in ('off', '0', 'false')

# 自建中继：直接拼前缀
CUSTOM_RELAY = None
if not DISABLED and _custom:
    CUSTOM_RELAY = _Relay('custom', '自建中继（GITHUB_RELAY）',
                          lambda p: f'{_custom.rstrip("/")}{p}')


def candidate_list():
    return ([CUSTOM_RELAY] + CANDIDATES) if CUSTOM_RELAY else list(CANDIDATES)


_lock = threading.Lock()
_active = None            # 选中的中继
_active_checked_at = 0
_last_failure = None      # 最近一次中继不可用的原因

# 中继「降权」（penalty）。
#
# 现实问题：公共中继会时好时坏。选中的中继若被缓存 30 分钟，
# 中途它开始 502 时我们只会**原地重试同一个**，一直失败到缓存过期为止——
# 表现就是"页面时好时坏、偶尔整个 502"。
#
# 所以某个中继一旦在真实业务请求上连续失败，就把它降权一段时间，
# 期间优先选别的候选；候选全被降权时仍然允许用它（避免直接不可用）。
RELAY_PENALTY_TTL = int(os.environ.get('RELAY_PENALTY_TTL_MS') or 90 * 1000)
_penalties = {}           # id -> 失效时间戳(ms)


def penalize_relay(rid, ms=RELAY_PENALTY_TTL):
    if not rid:
        return
    with _lock:
        _penalties[rid] = time.time() * 1000 + ms


def is_penalized(rid):
    with _lock:
        until = _penalties.get(rid)
        if not until:
            return False
        if time.time() * 1000 >= until:
            _penalties.pop(rid, None)
            return False
        return True


def penalty_state():
    now = time.time() * 1000
    with _lock:
        return [{'id': rid, 'forMs': int(until - now)}
                for rid, until in _penalties.items() if until > now]


def invalidate_active_relay():
    """强制重新探测：中继失效时调用，别让坏选择继续粘住"""
    global _active, _active_checked_at
    with _lock:
        _active = None
        _active_checked_at = 0


def _slim(relay):
    return {'id': relay.id, 'name': relay.name, 'url': relay.build('/rate_limit')}


def probe_relay(relay):
    """探测单个中继是否可用。

    用 /rate_limit 做探针：不消耗 GitHub 配额，且响应结构固定，容易校验真伪。
    """
    started = time.time() * 1000
    try:
        res = _do_request(relay.build('/rate_limit'), 'GET',
                          {'Accept': 'application/vnd.github+json', 'User-Agent': _UA},
                          RELAY_TIMEOUT, None)
        elapsed = int(time.time() * 1000 - started)
        if not res.ok:
            return {**_slim(relay), 'ok': False, 'status': res.status,
                    'ms': elapsed, 'error': f'HTTP {res.status}'}
        try:
            data = res.json()
        except Exception:
            data = None
        core = ((data or {}).get('resources') or {}).get('core') or {}
        if not isinstance(core.get('limit'), int):
            return {**_slim(relay), 'ok': False, 'status': res.status, 'ms': elapsed,
                    'error': '响应不是 GitHub API 结构（可能被中继改写）'}
        return {**_slim(relay), 'ok': True, 'status': res.status,
                'ms': elapsed, 'error': None, 'rateLimit': core}
    except Exception as err:
        code = error_code(err)
        message = f'超时（>{RELAY_TIMEOUT}ms）' if code == 'ETIMEDOUT' else code
        return {**_slim(relay), 'ok': False, 'status': None,
                'ms': int(time.time() * 1000 - started), 'error': str(message)}


# 并发去重：一次体检会并行打 10 个接口，一旦中继集体失败，
# 这 10 个请求会同时走到这里——不去重就是 10 轮完整探测（每轮 4 个候选），
# 既慢又可能把中继直接打挂。in-flight 的探测被复用。
_probe_event = None
_probe_box = {'results': None}
_probe_lock = threading.Lock()
# 探测结果的超短缓存：突发场景下把探测摊薄，避免在同一秒内重复打多轮完整探测。
# 1s 足够吸收突发，又不会让状态变陈旧。
RELAY_PROBE_MIN_INTERVAL = int(os.environ.get('RELAY_PROBE_MIN_INTERVAL_MS') or 1000)
# 调试/对照用：置 1 可关闭去重
PROBE_DEDUPE = os.environ.get('RELAY_NO_DEDUPE') != '1'
# 已经拿到可用候选后，再等其他候选的宽限期。
# 不加这个的话，一个连不上的候选会把整轮探测拖满 RELAY_TIMEOUT——
# 实测本机上 codetabs 超时 5.0s，比真正可用的 gh-proxy（0.57s）慢近一个数量级，
# 于是"选一个能用的中继"这件事白等 5 秒。有候选可用后最多再等这么久就收工。
RELAY_PROBE_GRACE = int(os.environ.get('RELAY_PROBE_GRACE_MS') or 400)
_last_probe_at = 0
_last_probe_results = None


def _settle_with_grace(relays, grace_ms, complete):
    """等所有候选落定；但一旦已有候选成功，只再等 graceMs 就返回。

    complete=True 时退化为全部等待（诊断报告需要完整结果）。
    """
    if not relays:
        return []

    pool = ThreadPoolExecutor(max_workers=len(relays))

    if complete:
        try:
            return list(pool.map(probe_relay, relays))
        finally:
            pool.shutdown(wait=True)

    settled = [None] * len(relays)
    futures = {pool.submit(probe_relay, r): i for i, r in enumerate(relays)}
    pending = set(futures)
    success_seen = False
    deadline = None

    while pending:
        timeout = max(0.0, deadline - time.time()) if (success_seen and deadline) else None
        done, pending = wait(pending, timeout=timeout, return_when=FIRST_COMPLETED)
        if not done:
            break                                   # 宽限期到，不再等剩下的
        for fut in done:
            i = futures[fut]
            try:
                settled[i] = fut.result()
            except Exception as err:
                settled[i] = {**_slim(relays[i]), 'ok': False, 'status': None,
                              'ms': None, 'error': str(err)}
            if settled[i]['ok'] and not success_seen:
                success_seen = True
                deadline = time.time() + grace_ms / 1000.0

    # 不在宽限期内返回的候选，如实标注（不假装它们失败）
    for i, item in enumerate(settled):
        if item is None:
            settled[i] = {**_slim(relays[i]), 'ok': False, 'status': None, 'ms': None,
                          'error': '未在宽限期内返回（已有可用候选，不再等待）'}

    pool.shutdown(wait=False)
    return settled


def probe_relays(force=False, complete=False):
    global _last_probe_at, _last_probe_results, _last_failure

    if PROBE_DEDUPE and not complete:
        if not force and _last_probe_results and \
                (time.time() * 1000 - _last_probe_at) < RELAY_PROBE_MIN_INTERVAL:
            return _last_probe_results
        # 已有探测在飞：等它出结果，避免 10 路并发打出 10 轮完整探测
        with _probe_lock:
            event = _probe_event
            box = _probe_box
        if event is not None:
            event.wait(RELAY_TIMEOUT / 1000.0 + 1)
            if box['results'] is not None:
                return box['results']

    with _probe_lock:
        if PROBE_DEDUPE and not complete and _probe_event is not None:
            event, box = _probe_event, _probe_box
        else:
            event, box = threading.Event(), {'results': None}
            if PROBE_DEDUPE and not complete:
                _probe_event, _probe_box = event, box
            else:
                event = None

    if event is None:                       # 不在去重模式：直接自己跑
        return _run_probes(complete)

    try:
        results = _run_probes(complete)
        box['results'] = results
        return results
    finally:
        with _probe_lock:
            if _probe_event is event:
                _probe_event, _probe_box = None, None
        event.set()


def _run_probes(complete):
    results = _settle_with_grace(candidate_list(), RELAY_PROBE_GRACE, complete)
    ok = sorted([r for r in results if r['ok']], key=lambda r: r['ms'])
    _set_last_failure(None if ok else (results[0].get('error') if results else '无可用中继'))
    if not complete:
        _set_probe_cache(results)
    return results


def _set_probe_cache(results):
    global _last_probe_at, _last_probe_results
    with _lock:
        _last_probe_at = int(time.time() * 1000)
        _last_probe_results = results


def _set_last_failure(reason):
    global _last_failure
    with _lock:
        _last_failure = reason


def ensure_active_relay(exclude=None):
    """选出可用的中继并缓存（正结果缓存 30 分钟，负结果缓存 60 秒）。

    选择顺序：未被降权且不在 exclude 里的候选，按探测耗时从快到慢。
    若全都被降权，则退而用最快的那个——"可能不稳"好过"完全没有数据"。
    """
    global _active, _active_checked_at
    if DISABLED:
        return None
    exclude = list(exclude or [])

    with _lock:
        age = int(time.time() * 1000) - _active_checked_at
        if _active and _active_checked_at and age < RELAY_TTL:
            return _active
        if not _active and _active_checked_at and age < RELAY_NEGATIVE_TTL:
            return None

    results = probe_relays()
    ok = sorted([r for r in results if r['ok']], key=lambda r: r['ms'])
    usable = [r for r in ok if r['id'] not in exclude and not is_penalized(r['id'])]
    fallback = [r for r in ok if r['id'] not in exclude]
    winner = (usable or fallback or [None])[0]

    chosen = None
    if winner:
        chosen = next((r for r in candidate_list() if r.id == winner['id']), None)
    with _lock:
        _active = chosen
        _active_checked_at = int(time.time() * 1000)
    return _active


def get_active_relay():
    with _lock:
        return None if DISABLED else _active


def is_disabled():
    return DISABLED
