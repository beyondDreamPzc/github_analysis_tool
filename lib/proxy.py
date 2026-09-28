"""出网代理支持（零第三方依赖）。

为什么需要这个模块：
  标准库 urllib 默认就会读 HTTPS_PROXY / HTTP_PROXY 这类变量，行为与 curl / git 一致。
  但只有这一点远远不够 —— 现实中的代理环境有三个坑，本模块专门处理它们：

    1. 环境里已经有一个「能连上但用不了」的代理（企业白名单代理、只放行个别路径的
       内部代理、已经失效却仍被环境变量指向的代理）。对这类代理死心塌地，
       结果会比不配代理更糟 —— 所以需要 GITHUB_PROXY 做优先级覆盖，以及熔断兜底。
    2. `git config --global http.proxy` 只影响 git 自身，改变不了本进程的出口，
       排查时极容易被这个事实误导。
    3. 代理失败后必须回落直连，并把「为什么回落」如实带出去，否则用户会以为
       「配了代理反而更糟」，却看不到真正的原因。

支持的配置（优先级从高到低）：
  GITHUB_PROXY / PROXY_URL   本工具专用，显式指定，优先级最高
  https_proxy / HTTPS_PROXY  HTTPS 目标
  http_proxy  / HTTP_PROXY   HTTP 目标
  all_proxy   / ALL_PROXY    兜底
  no_proxy    / NO_PROXY     例外名单，支持 example.com、.example.com、example.com:8080、*

安全约定：
  - 代理地址中的凭据只用于构造 Proxy-Authorization，绝不出现在日志与诊断输出里；
  - 目标服务器的 TLS 证书仍按标准校验；
  - 跨主机重定向时自动摘掉 Authorization，不把凭据交给第三方。
"""
import base64
import json as _json
import os
import re
import socket
import ssl
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from urllib.request import (
    HTTPErrorProcessor,
    HTTPRedirectHandler,
    HTTPSHandler,
    ProxyHandler,
    Request,
    build_opener,
)

PROXY_TIMEOUT = int(os.environ.get('PROXY_TIMEOUT_MS') or 12000)

# 代理熔断：连续失败阈值 + 停用时长
PROXY_FAIL_THRESHOLD = int(os.environ.get('PROXY_FAIL_THRESHOLD') or 3)
PROXY_SUPPRESS_TTL = int(os.environ.get('PROXY_SUPPRESS_TTL_MS') or 10 * 60 * 1000)

_HTTPS_KEYS = ('https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')
_HTTP_KEYS = ('http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY')

_lock = threading.Lock()
_circuit = {
    'failures': 0,
    'suppressedUntil': 0,
    'reason': None,
    'url': None,
}


class NetworkError(Exception):
    """带机器可读 code 的网络错误，供上层翻译成人话"""

    def __init__(self, message, code, **extra):
        super().__init__(message)
        self.code = code
        for k, v in extra.items():
            setattr(self, k, v)


class HttpResponse:
    """与 fetch Response 对齐的最小子集（status / ok / headers.get / text / json）"""

    def __init__(self, status, headers, body, url, via_proxy=False):
        self.status = status
        self.headers = headers          # email.message.Message，get() 大小写不敏感
        self._body = body or b''
        self.url = url
        self._via_proxy = via_proxy
        self._proxy_fallback = None

    @property
    def ok(self):
        return 200 <= self.status < 300

    def text(self):
        return self._body.decode('utf-8', errors='replace')

    def json(self):
        return _json.loads(self._body.decode('utf-8', errors='replace'))


_REDIRECT_CODES = (301, 302, 303, 307, 308)


class _NoRaiseProcessor(HTTPErrorProcessor):
    """非 2xx 也把响应交回来，让上层自己按状态码分支（与 fetch 语义一致）。

    但 3xx 必须放行给标准流程 —— urllib 的重定向正是由 HTTPErrorProcessor
    派发到 HTTPRedirectHandler 的，如果这里一律直接 return，
    重定向就不再跟随：被改名过的仓库（如 facebook/react → react/react）会直接以
    301 报错，而这类失败看起来完全不像重定向问题，极难排查。
    """

    def http_response(self, request, response):
        if response.status in _REDIRECT_CODES:
            try:
                return HTTPErrorProcessor.http_response(self, request, response)
            except HTTPError:
                # 没有 Location 之类的不可跟随情况：如实把 3xx 交回上层
                return response
        return response

    https_response = http_response


class _SafeRedirectHandler(HTTPRedirectHandler):
    """跨主机重定向时摘掉 Authorization（urllib 默认不摘，属于凭据泄露）"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        try:
            if urlsplit(req.full_url).netloc != urlsplit(new.full_url).netloc:
                new.remove_header('Authorization')
        except Exception:
            pass
        return new


# ---------------------------------------------------------------- 代理解析

def _normalize_proxy_url(raw):
    """把 http://host:port、host:port 之类都规整成规范化字符串；不合法返回 None"""
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    if not re.match(r'^[a-z][a-z0-9+.-]*://', value, re.I):
        value = 'http://' + value
    parts = urlsplit(value)
    if parts.scheme not in ('http', 'https'):
        return None                      # socks 暂不支持
    netloc = parts.netloc
    if parts.port is None:
        default_port = 443 if parts.scheme == 'https' else 80
        host = parts.hostname or ''
        auth = ''
        if parts.username:
            auth = quote(unquote(parts.username), safe='')
            if parts.password:
                auth += ':' + quote(unquote(parts.password), safe='')
            auth += '@'
        netloc = f'{auth}{host}:{default_port}'
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, ''))


def no_proxy_list():
    raw = os.environ.get('no_proxy') or os.environ.get('NO_PROXY') or ''
    return [s.strip().lower() for s in str(raw).split(',') if s.strip()]


def is_bypassed(host, port):
    """NO_PROXY 匹配：支持后缀匹配、可选端口、通配 *"""
    target = str(host or '').lower()
    for item in no_proxy_list():
        if item == '*':
            return True
        pattern, pattern_port = item, None
        colon = pattern.rfind(':')
        if colon > 0 and pattern[colon + 1:].isdigit():
            pattern_port = pattern[colon + 1:]
            pattern = pattern[:colon]
        if pattern_port and str(port) != pattern_port:
            continue
        bare = pattern[1:] if pattern.startswith('.') else pattern
        if not bare:
            continue
        if target == bare or target.endswith('.' + bare):
            return True
    return False


def resolve_proxy(target_url):
    """决定某个目标地址该走哪个代理；返回 None 表示直连"""
    raw = os.environ.get('GITHUB_PROXY') or os.environ.get('PROXY_URL') or None
    source = 'GITHUB_PROXY' if raw else None

    if not raw:
        keys = _HTTPS_KEYS if str(target_url).startswith('https:') else _HTTP_KEYS
        for key in keys:
            if os.environ.get(key):
                raw = os.environ[key]
                source = key
                break

    normalized = _normalize_proxy_url(raw)
    if not normalized:
        return None

    try:
        parts = urlsplit(target_url)
        port = parts.port or (443 if parts.scheme == 'https' else 80)
        if is_bypassed(parts.hostname, port):
            return None
    except Exception:
        return None

    with _lock:
        suppressed = _circuit['suppressedUntil'] > time.time() * 1000
    if suppressed:                       # 熔断期内直接当没配代理
        return None

    return {'url': normalized, 'source': source}


def mask_proxy(url):
    """打码，避免把凭据写进日志 / 诊断输出"""
    parts = urlsplit(str(url))
    if parts.username or parts.password:
        host = parts.hostname or ''
        port = f':{parts.port}' if parts.port else ''
        netloc = f'***@{host}{port}'
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, ''))
    return str(url)


def note_proxy_success():
    """代理成功一次就清零失败计数"""
    with _lock:
        if _circuit['failures'] or _circuit['suppressedUntil']:
            _circuit.update(failures=0, suppressedUntil=0, reason=None, url=None)


def note_proxy_failure(proxy, why):
    """代理失败累计到阈值就熔断一段时间"""
    with _lock:
        _circuit['failures'] += 1
        if _circuit['failures'] < PROXY_FAIL_THRESHOLD:
            return
        _circuit['suppressedUntil'] = time.time() * 1000 + PROXY_SUPPRESS_TTL
        _circuit['reason'] = why
        _circuit['url'] = mask_proxy(proxy['url']) if proxy else None
        failed = _circuit['failures']
        shown = _circuit['url'] or '(未知名)'
        _circuit['failures'] = 0
    print(
        f'[proxy] 代理 {shown} 连续 {failed} 次不可用（{why}），'
        f'已暂时停用 {round(PROXY_SUPPRESS_TTL / 60000)} 分钟，本段时间内改走直连/备用通道。'
        ' 如需指定别的代理，请设置 GITHUB_PROXY。'
    )


def get_circuit_state():
    """诊断用：熔断状态"""
    with _lock:
        active = _circuit['suppressedUntil'] > time.time() * 1000
        return {
            'suppressed': active,
            'until': _iso(_circuit['suppressedUntil']) if active else None,
            'reason': _circuit['reason'],
            'url': _circuit['url'],
            'failures': _circuit['failures'],
        }


def _iso(ms):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(ms / 1000)) + 'Z'


def get_proxy_status(target_url='https://api.github.com'):
    proxy = resolve_proxy(target_url)
    return {
        'configured': bool(proxy),
        'via': proxy['source'] if proxy else None,
        'url': mask_proxy(proxy['url']) if proxy else None,
        'noProxy': no_proxy_list(),
        'target': target_url,
        'circuit': get_circuit_state(),
    }


# ---------------------------------------------------------------- 错误翻译

def error_code(err):
    """从各类异常里抽出机器可读的 code，供 describe_fetch_error 翻译成人话"""
    if isinstance(err, NetworkError):
        return err.code
    if isinstance(err, HTTPError):                 # 理论上已被 _NoRaiseProcessor 拦下
        return f'HTTP_{err.code}'
    if isinstance(err, URLError):
        reason = err.reason
        if isinstance(reason, socket.gaierror):
            return 'ENOTFOUND' if reason.errno in (-2, -5, 11001) else 'EAI_AGAIN'
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return 'ETIMEDOUT'
        if isinstance(reason, ConnectionRefusedError):
            return 'ECONNREFUSED'
        if isinstance(reason, ConnectionResetError):
            return 'ECONNRESET'
        if isinstance(reason, ssl.SSLCertVerificationError):
            return 'CERT_VERIFY_FAILED'
        if isinstance(reason, ssl.SSLError):
            return 'TLS_ERROR'
        if isinstance(reason, OSError) and reason.errno is not None:
            return {11001: 'ENOTFOUND', 11002: 'EAI_AGAIN', 10061: 'ECONNREFUSED',
                    10054: 'ECONNRESET', 10060: 'ETIMEDOUT'}.get(reason.errno, f'ERRNO_{reason.errno}')
        return 'FETCH_FAILED'
    if isinstance(err, (socket.timeout, TimeoutError)):
        return 'ETIMEDOUT'
    if isinstance(err, ConnectionResetError):
        return 'ECONNRESET'
    if isinstance(err, ConnectionRefusedError):
        return 'ECONNREFUSED'
    if isinstance(err, socket.gaierror):
        return 'ENOTFOUND'
    if isinstance(err, ssl.SSLError):
        return 'TLS_ERROR'
    return 'FETCH_FAILED'


def _is_timeout(err):
    if isinstance(err, NetworkError) and err.code == 'ETIMEDOUT':
        return True
    if isinstance(err, (socket.timeout, TimeoutError)):
        return True
    if isinstance(err, URLError) and isinstance(err.reason, (socket.timeout, TimeoutError)):
        return True
    return False


def _is_proxy_unreachable(err):
    """连代理这一步就失败 → 代理本身不可用"""
    return error_code(err) in ('ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH',
                               'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT')


# ---------------------------------------------------------------- 请求

def _build_opener(proxy_url, insecure_tls=False):
    handlers = []
    if proxy_url:
        handlers.append(ProxyHandler({'http': proxy_url, 'https': proxy_url}))
    else:
        # 显式传空 dict：跳过默认那个会读系统/环境代理的 ProxyHandler，
        # 「直连」就必须真的是直连。
        handlers.append(ProxyHandler({}))
    if insecure_tls:
        # 公司内网常见自签证书的 https 代理；仅在显式开启时放宽「代理这一跳」的校验
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        handlers.append(HTTPSHandler(context=context))
    handlers += [_NoRaiseProcessor(), _SafeRedirectHandler()]
    return build_opener(*handlers)


def _do_request(url, method, headers, timeout, proxy_url, insecure_tls=False):
    opener = _build_opener(proxy_url, insecure_tls)
    req_headers = dict(headers or {})
    # 代理鉴权头提前带上（urllib 默认要等 407 才发，白多一次往返）
    if proxy_url:
        parts = urlsplit(proxy_url)
        if parts.username:
            cred = f'{unquote(parts.username)}:{unquote(parts.password or "")}'
            req_headers['Proxy-Authorization'] = (
                'Basic ' + base64.b64encode(cred.encode('utf-8')).decode('ascii'))
    req = Request(url, method=method.upper(), headers=req_headers)
    resp = opener.open(req, timeout=max(0.001, timeout / 1000.0) if timeout else None)
    try:
        body = resp.read()
        return HttpResponse(resp.status, resp.headers, body, resp.geturl(), via_proxy=bool(proxy_url))
    finally:
        resp.close()


def proxied_request(target_url, method='GET', headers=None, timeout=PROXY_TIMEOUT, proxy=None):
    """经代理发起一次请求"""
    return _do_request(target_url, method, headers, timeout,
                       proxy['url'] if proxy else None,
                       insecure_tls=os.environ.get('PROXY_INSECURE_TLS') == '1')


def http_get(url, method='GET', headers=None, timeout=PROXY_TIMEOUT):
    """统一的 GET 入口，策略是「代理优先，但两条路都试」：

      1. 没配代理        → 直接走直连（零开销，行为与不支持代理时完全一致）
      2. 配了代理且成功   → 用代理的结果
      3. 配了代理但失败   → 回落直连再试一次

    第 3 条很关键：现实中的代理经常是"能连但不放行某些域名"（企业白名单代理、
    带策略的隧道代理都属于这类）。如果死守代理，就会出现「配了代理反而更糟」——
    明明直连本来能通。所以这里两个方向都兜住，并把实际生效的那条路打日志说明。
    """
    proxy = resolve_proxy(url)
    if not proxy:
        return _do_request(url, method, headers, timeout, None)

    try:
        res = proxied_request(url, method=method, headers=headers, timeout=timeout, proxy=proxy)
    except Exception as err:
        why = error_code(err)
        note_proxy_failure(proxy, why)
        hint = '代理不可达' if _is_proxy_unreachable(err) else '经代理访问失败'
        print(f'[proxy] {hint}（{why}），回落直连重试')

        try:
            res = _do_request(url, method, headers, timeout, None)
        except Exception as direct_err:
            combined = NetworkError(
                f'代理与直连均失败（代理：{why}；直连：{error_code(direct_err)}）',
                error_code(direct_err),
            )
            raise combined from direct_err
        print('[proxy] 直连成功 —— 本次数据来自直连，代理配置可能不适用于该目标')
        # 把「为什么回落」如实带出去，供 /api/diag 与日志使用，
        # 避免上层把根因笼统描述成「代理不可用」
        res._proxy_fallback = {'code': why, 'reason': str(err)}
        return res

    note_proxy_success()
    # 重定向由 urllib 自动跟随（跨主机会摘掉 Authorization，见 _SafeRedirectHandler），
    # 因此「配了代理」与「没配代理」的重定向语义天然一致。
    return res
