"""轻量 .env 加载（零依赖，替代 python-dotenv）。

语义：
  - **已存在的环境变量优先**，不覆盖 —— 便于容器 / CI 用真实环境变量覆盖文件配置；
  - 去掉值两端的空白；
  - 去掉「成对包裹」的引号；
  - 剥离值后面的行尾注释，但只认「空白 + #」，
    避免误伤值本身含 # 的情况（URL fragment、密码等）。

为什么要专门做这些清理：
  手填 Token 时最高频的失效原因不是 token 错，而是**值写脏了** ——
  末尾多一个空格、粘贴时带上了引号、顺手在后面写了句注释。
  这些情况下程序只会报 401 / 配额没变，极难联想到是配置文件的问题。
"""
import os
import re

_LINE_RE = re.compile(r'^([\w.-]+)\s*=\s*(.*)$')


def parse_env(text):
    """把 .env 文本解析成键值字典（抽成独立函数以便单测）"""
    out = {}
    for raw_line in str(text).split('\n'):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        m = _LINE_RE.match(line)
        if not m:
            continue

        value = m.group(2).strip()
        # 行尾注释：`KEY=value  # 说明` -> value。只认「空白 + #」，不动 `KEY=a#b`
        hash_idx = re.search(r'\s#', value)
        if hash_idx:
            value = value[:hash_idx.start()].strip()
        # 仅当引号成对包裹时剥离，避免把值里本就不配对的引号也吃掉
        if len(value) > 1 and value[0] in ('"', "'") and value.endswith(value[0]):
            value = value[1:-1]
        out[m.group(1)] = value
    return out


def load_dot_env(directory=None):
    """加载 .env 到 os.environ。

    返回 dict: {file, exists, applied, skipped}
    """
    root = directory or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    file_path = os.path.join(root, '.env')
    if not os.path.exists(file_path):
        return {'file': file_path, 'exists': False, 'applied': [], 'skipped': []}

    with open(file_path, 'r', encoding='utf-8') as f:
        parsed = parse_env(f.read())

    applied, skipped = [], []
    for key, value in parsed.items():
        if os.environ.get(key):        # 环境变量优先
            skipped.append(key)
            continue
        os.environ[key] = value
        applied.append(key)
    return {'file': file_path, 'exists': True, 'applied': applied, 'skipped': skipped}
