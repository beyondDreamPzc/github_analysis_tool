#!/usr/bin/env python3
"""GitHub 仓库体检工具 —— 服务端

零第三方依赖：只用标准库 http.server / urllib / json / threading。

接口：
  GET  /api/health                    健康探针（含 GitHub 出网可达性）
  GET  /api/analyze?repo=<url>&refresh=1   采集 + 规则评分，返回完整指标
  POST /api/ai-review                 基于已缓存的指标做 AI 点评（可携带 apiKey）
  GET  /api/limits                    查看当前 GitHub API 配额
  GET  /api/diag                      出网诊断（DNS / 各域名连通性 / 代理变量）
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# 轻量 .env 加载：避免引入 python-dotenv 依赖，同时保证配置在 lib 模块初始化前生效。
# 解析细节（去引号 / 去尾随空格 / 剥离行尾注释）见 lib/env.py。
from lib.env import load_dot_env

load_dot_env(os.path.dirname(os.path.abspath(__file__)))

from lib.diag import format_report, run_diagnostics                              # noqa: E402
from lib.github import (GitHubError, analyze_repo, get_connectivity, gh_fetch,   # noqa: E402
                        get_proxy_status, parse_repo_input, probe_connectivity)
from lib.relay import (candidate_list, ensure_active_relay, get_active_relay,    # noqa: E402
                       is_disabled as is_relay_disabled)
from lib.score import ai_review, compute_score, local_review                     # noqa: E402

PORT = int(os.environ.get('PORT') or 8787)
HOST = os.environ.get('HOST') or '0.0.0.0'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
}


def _asset_version():
    """静态资源指纹。

    静态文件带 1 小时强缓存，如果资源 URL 不变，升级代码后用户浏览器/边缘节点
    仍会继续跑旧版 JS（表现为「后端改了、页面没变」）。这里按文件大小+修改时间
    生成一个短指纹，注入到 index.html 的资源引用上：文件一变，URL 就变。
    """
    parts = []
    try:
        for name in ('app.js', 'styles.css', os.path.join('vendor', 'chart.umd.js')):
            st = os.stat(os.path.join(PUBLIC_DIR, name))
            parts.append(f'{int(st.st_size):x}{int(st.st_mtime * 1000):x}')
        return ''.join(parts)[-10:]
    except OSError:
        return format(int(time.time() * 1000), 'x')[-10:]


ASSET_VERSION = _asset_version()


def build_failure_hint(err):
    """把失败翻译成「下一步该做什么」"""
    status = getattr(err, 'status', None)
    code = (getattr(err, 'detail', None) or {}).get('code')
    if status == 404:
        return '请检查仓库名拼写是否正确；本工具只支持公开仓库（私有仓库需要带权限的 Token）。'
    if status == 401:
        return ('GitHub 拒绝了这串 Token（401 Bad credentials）：它可能已失效、被撤销，'
                '或复制时带了多余的空格 / 字符。'
                '到页面「⚙️ 高级设置」里重新粘贴一个即可；也可以清空它，改用匿名配额（60 次/小时，多人共享）。')
    if status == 429:
        return ('网络是通的，只是这个出口 IP 的匿名配额（60 次/小时，多人共享）用完了。'
                '推荐配上 GITHUB_TOKEN（免费，上限 5000 次/小时）根治；'
                '临时也可经代理换一个出口 IP（设置 GITHUB_PROXY=http://127.0.0.1:7890 这类），会拿到另一份额度。')
    if status in (502, 504) or code:
        relay = get_active_relay()
        if relay:
            return (f'直连 api.github.com 失败，备用通道「{relay.name}」也没能取到数据'
                    '（可能是网络波动或该仓库不存在）。可点「重试」，或打开 /api/diag 看出网诊断。')
        return ('当前运行环境无法访问 api.github.com（DNS / 出网受限），且没有可用的备用通道。'
                '或在本机运行本工具获得实时数据；打开 /api/diag 可看到逐域名连通性诊断。')
    return '请稍后重试；若持续失败，打开 /api/diag 查看出网诊断。'


class Handler(BaseHTTPRequestHandler):
    server_version = 'github-health-check/1.0'
    protocol_version = 'HTTP/1.1'

    # ---------------------------------------------------------- 响应工具

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, status, text, content_type='text/plain; charset=utf-8'):
        body = text.encode('utf-8') if isinstance(text, str) else text
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit=256 * 1024):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError('请求体过大')
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            raise ValueError('请求体不是合法 JSON')

    def request_token(self):
        """请求头里的 Token（页面「高级设置」填的那个），顺手 trim。

        Token 里混进一个空格就会变成 401，而这个报错完全看不出是空格引起的。
        """
        return str(self.headers.get('x-github-token') or '').strip()

    # ---------------------------------------------------------- 路由

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_HEAD(self):
        self.dispatch('GET')

    def dispatch(self, method):
        parsed = urlparse(self.path)
        pathname = parsed.path
        query = parse_qs(parsed.query)
        try:
            if pathname == '/api/health':
                return self.handle_health()
            if pathname == '/api/diag':
                return self.handle_diag(query)
            if pathname == '/api/limits':
                return self.handle_limits()
            if pathname == '/api/analyze':
                if method != 'GET':
                    return self.send_json(405, {'error': '仅支持 GET'})
                return self.handle_analyze(query)
            if pathname == '/api/ai-review':
                if method != 'POST':
                    return self.send_json(405, {'error': '仅支持 POST'})
                return self.handle_ai_review()
            if pathname.startswith('/api/'):
                return self.send_json(404, {'error': '接口不存在'})
            return self.serve_static(pathname)
        except ValueError as err:
            return self.send_json(400, {'error': str(err)})
        except Exception as err:
            status = err.status if isinstance(err, GitHubError) else 500
            message = str(err) if isinstance(err, GitHubError) else f'服务端异常：{err}'
            if not isinstance(err, GitHubError):
                import traceback
                traceback.print_exc()
            self.send_json(status, {'error': message,
                                    'detail': getattr(err, 'detail', None)})

    # ---------------------------------------------------------- API

    def handle_health(self):
        conn = get_connectivity()
        # 页面可以自带 Token（存浏览器本地，不落盘），所以这里不能只看环境变量：
        # 否则用户明明已经在页面上填好，横幅却仍然说他「未配置」，前后自相矛盾。
        req_token = self.request_token()
        env_token = bool(os.environ.get('GITHUB_TOKEN'))
        active = get_active_relay()
        self.send_json(200, {
            'ok': True,
            'uptimeSec': round(_uptime()),
            'runtime': f'Python {sys.version.split()[0]}',
            'aiConfigured': bool(os.environ.get('OPENAI_API_KEY') or os.environ.get('AI_API_KEY')),
            'githubTokenConfigured': bool(req_token or env_token),
            # 让前端能区分「页面填的」和「服务端配的」，好在横幅里给对应的反馈
            'githubTokenSource': 'request' if req_token else ('env' if env_token else None),
            # 出网可达性：null 表示还没探测出结果
            'githubReachable': conn.get('ok'),
            'githubConnectivity': conn,
            # 代理配置（凭据已打码）
            'proxy': get_proxy_status(),
            # 备用通道状态：受限网络下能否照常实时体检，取决于这一项
            'relay': {'disabled': is_relay_disabled(), 'active': active.id if active else None},
        })

    def handle_diag(self, query):
        report = run_diagnostics(source='api')
        if (query.get('format') or [''])[0] == 'text':
            return self.send_text(200, format_report(report))
        return self.send_json(200, report)

    def handle_limits(self):
        result = gh_fetch('/rate_limit')
        core = ((result.get('data') or {}).get('resources') or {}).get('core')
        return self.send_json(200, {'ok': True, 'core': core})

    def handle_analyze(self, query):
        raw_input = (query.get('repo') or query.get('url') or [''])[0]
        parsed = parse_repo_input(raw_input)
        if not parsed:
            return self.send_json(400, {
                'error': '无法解析仓库地址',
                'hint': '请输入形如 https://github.com/facebook/react 或 facebook/react 的公开仓库地址',
            })
        force = (query.get('refresh') or [''])[0] == '1'
        token = self.request_token() or os.environ.get('GITHUB_TOKEN')

        try:
            metrics = analyze_repo(parsed['owner'], parsed['repo'], token=token, force=force)
        except Exception as err:
            # 采集失败时直接报错，不做"静默降级"。
            # 尤其 401：属于「配置问题」而不是「网络问题」，若悄悄换一份数据给用户，
            # 他会拿到一份看起来正常的报告，完全察觉不到自己的 Token 是坏的。
            conn = get_connectivity()
            detail = getattr(err, 'detail', None) or {}
            status = getattr(err, 'status', None) or 502
            # 这个 code 会作为标签直接显示在失败面板上，所以必须反映真实性质：
            # 401 是凭据问题、403/429 是额度问题，标成 NETWORK 会把人引向错误的方向。
            if status == 401:
                code = 'AUTH'
            elif detail.get('quotaExhausted'):
                code = 'QUOTA'
            else:
                code = detail.get('code') or conn.get('code') or 'NETWORK'
            return self.send_json(status, {
                'error': str(err),
                'code': code,
                'hint': build_failure_hint(err),
                'apiBase': conn.get('apiBase'),
                'githubReachable': conn.get('ok'),
                'diagUrl': '/api/diag',
            })

        score = compute_score(metrics)
        review = local_review(metrics, score)
        return self.send_json(200, {
            'ok': True,
            'repo': metrics,
            'score': score,
            'review': review,
            'aiAvailable': bool(os.environ.get('OPENAI_API_KEY') or os.environ.get('AI_API_KEY')),
        })

    def handle_ai_review(self):
        body = self.read_body()
        parsed = parse_repo_input(body.get('repo') or '')
        if not parsed:
            return self.send_json(400, {'error': '缺少合法的 repo 参数'})

        token = body.get('githubToken') or os.environ.get('GITHUB_TOKEN')
        metrics = analyze_repo(parsed['owner'], parsed['repo'], token=token)
        score = compute_score(metrics)
        review = ai_review(metrics, score,
                           api_key=body.get('apiKey'),
                           base_url=body.get('baseUrl'),
                           model=body.get('model'))
        return self.send_json(200, {'ok': True, 'review': review, 'scoreTotal': score['total']})

    # ---------------------------------------------------------- 静态资源

    def serve_static(self, url_path):
        rel = 'index.html' if url_path == '/' else unquote(url_path).lstrip('/')
        target = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        # 目录穿越防护
        if not target.startswith(PUBLIC_DIR):
            return self.send_text(403, 'Forbidden')

        if not os.path.isfile(target):
            # 前端是单页应用，未命中的非资源路径回落到 index.html
            if not os.path.splitext(rel)[1]:
                index = os.path.join(PUBLIC_DIR, 'index.html')
                if not os.path.isfile(index):
                    return self.send_text(404, 'Not Found')
                with open(index, 'rb') as f:
                    html = f.read()
                return self.send_text(200, inject_version(html), MIME['.html'])
            return self.send_text(404, 'Not Found')

        ext = os.path.splitext(target)[1].lower()
        try:
            with open(target, 'rb') as f:
                data = f.read()
        except OSError:
            return self.send_text(404, 'Not Found')

        if ext == '.html':
            # HTML 不缓存，并把资源指纹注入进去，保证每次升级都能拿到新 JS/CSS
            self.send_response(200)
            self.send_header('Content-Type', MIME['.html'])
            self.send_header('Cache-Control', 'no-cache')
            body = inject_version(data)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        return self.wfile.write(data)

    def log_message(self, fmt, *args):
        # 保留一层简短访问日志，避免默认实现把噪音全打出来
        sys.stderr.write('[http] %s %s\n' % (self.address_string(), fmt % args))


def inject_version(html):
    """注入资源指纹；保持入参的类型（bytes 进 bytes 出）——直接写 socket 时必须给 bytes。"""
    if isinstance(html, bytes):
        return html.replace(b'__ASSET_VERSION__', ASSET_VERSION.encode('utf-8'))
    return html.replace('__ASSET_VERSION__', ASSET_VERSION)


_started_at = time.time()


def _uptime():
    return time.time() - _started_at


def _banner(shown):
    token_state = ('已配置（5000 次/小时）' if os.environ.get('GITHUB_TOKEN')
                   else '未配置（60 次/小时，建议配置）')
    proxy_status = get_proxy_status()
    proxy_state = (f"已启用 · {proxy_status['via']} → {proxy_status['url']}"
                   if proxy_status['configured']
                   else '未配置（如需代理：设置 HTTPS_PROXY 或 GITHUB_PROXY）')
    ai_state = ('已配置（调用大模型）'
                if os.environ.get('OPENAI_API_KEY') or os.environ.get('AI_API_KEY')
                else '未配置（使用内置规则引擎）')
    print('┌───────────────────────────────────────────────┐')
    print('│  GitHub 仓库体检 · Repo Health Check          │')
    print('└───────────────────────────────────────────────┘')
    print(f'  页面地址:   http://{shown}:{PORT}')
    print(f'  Python 版本: {sys.version.split()[0]}')
    print(f'  GitHub Token: {token_state}')
    print(f'  出网代理:   {proxy_state}')
    print(f'  AI 点评:    {ai_state}')
    print('  GitHub 出网: 探测中…（/rate_limit 不消耗配额）')
    print('')


def _startup_probe(shown):
    """启动后异步探测出网能力，失败不阻塞服务"""
    try:
        conn = probe_connectivity(source='startup')
        if conn.get('ok'):
            via = f" · 经代理 {conn['proxy']['via']}" if (conn.get('proxy') or {}).get('configured') else ''
            rate = conn.get('rateLimit') or {}
            left, limit = rate.get('remaining'), rate.get('limit')
            print(f'[出网] 正常 · {conn["ms"]}ms · 剩余配额 {left if left is not None else "?"}'
                  f'/{limit if limit is not None else "?"}{via}')
            # 能连通但配额见底：这是后续所有请求都会 403 的前兆，必须提前说清楚
            if left == 0 and not os.environ.get('GITHUB_TOKEN'):
                print('[出网] ⚠ 匿名配额已耗尽：出网本身是通的，但 GitHub 会拒绝后续请求（HTTP 403）。')
                print('[出网]   根治：配置 GITHUB_TOKEN（60 → 5000 次/小时）。')
                print('[出网]   临时：换出口 IP，例如 GITHUB_PROXY=http://127.0.0.1:7890（会拿到独立额度）。')
            return

        print(f'[出网] 直连不可用 —— {conn.get("error")}（code={conn.get("code")}）')
        if is_relay_disabled():
            print('[出网] 备用通道已被 GITHUB_RELAY=off 关闭，实时体检不可用')
            return
        print('[出网] 正在寻找可用备用通道…')
        relay = ensure_active_relay()
        if relay:
            print(f'[出网] 已启用备用通道：{relay.name}')
            print('[出网] 中继通道不携带 Token，仅支持公开仓库')
        else:
            tried = '、'.join(r.name for r in candidate_list())
            print(f'[出网] 无可用备用通道（已尝试：{tried}），实时体检不可用')
            print(f'[出网] 诊断详情见 http://{shown}:{PORT}/api/diag?format=text')
    except Exception as err:
        print(f'[出网] 探测异常：{err}')


def main():
    shown = 'localhost' if HOST == '0.0.0.0' else HOST
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    _banner(shown)
    threading.Thread(target=_startup_probe, args=(shown,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
