"""健康度评分引擎。

设计原则：可解释。每个分数都能回溯到具体的原始数据与阈值，
前端会把每个「子因子」的得分与说明一并展示，避免变成黑盒评分。

五个维度（满分 100）：
  1. 社区影响力 influence    25 分 —— Star / Fork / Watch
  2. 活跃程度   activity     25 分 —— 最近提交、提交频次、发版节奏
  3. 维护质量   maintenance  20 分 —— Issue 处理、社区健康度、文档
  4. 协作广度   collaboration 15 分 —— 贡献者规模、总线因子
  5. 工程规范   engineering  15 分 —— License、CI、测试、工程文件
"""
import json as _json
import math
import os
import re
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext

GRADES = [
    {'min': 90, 'grade': 'S', 'label': '卓越', 'color': '#7c3aed'},
    {'min': 80, 'grade': 'A', 'label': '优秀', 'color': '#16a34a'},
    {'min': 70, 'grade': 'B', 'label': '良好', 'color': '#0ea5e9'},
    {'min': 60, 'grade': 'C', 'label': '一般', 'color': '#f59e0b'},
    {'min': 0, 'grade': 'D', 'label': '待改进', 'color': '#ef4444'},
]


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def js_round(v, d=1):
    """对齐 JavaScript 的 `+Number(v.toFixed(d))`。

    不能直接用 Python 的 round()：它是「四舍六入五取偶」，而 JS 的 toFixed 是
    对 double 的**精确十进制值**做「五入」。两者在 4.35 这类值上会分道扬镳 ——
    4.35 的 double 其实是 4.34999999999999964…，JS 得 4.3；
    而 `4.35 * 10` 先算出 43.5，再取整就变成 4.4，整份报告会莫名多出 0.1 分。
    用 Decimal 拿到精确值再 quantize，才能和 JS 完全一致。

    返回值在**恰为整数时收成 int**，这不是偷懒，而是在复刻 JS 的数值模型：
    JS 只有一种 number 类型，`100.0 === 100`，所以 `${100.0}` 打出的是 "100"。
    Python 若保持 float，同一处会打出 "100.0" —— 而 `percent` 恰恰经常落在整数上
    （工程规范 100%、单一语言仓库 100%、维度满分 25/25），这个尾零会直接漏到
    用户可见的点评文案里。收成 int 后，f-string、json.dumps、
    `json.dumps` 的整数语义都与 JS 对齐，无需在每个插值点单独兜底。
    """
    if v is None:
        return None
    dec = Decimal(v) if not isinstance(v, Decimal) else v
    quantum = Decimal(1).scaleb(-d)
    with localcontext() as ctx:
        ctx.prec = 60
        out = float(dec.quantize(quantum, rounding=ROUND_HALF_UP))
    # bool 是 int 的子类，这里不会遇到；用 is_integer 判断是否为整数值
    return int(out) if out.is_integer() else out


def js_math_round(v):
    """对齐 JavaScript 的 Math.round（.5 向正无穷）"""
    if v is None:
        return None
    return int(math.floor(float(v) + 0.5))


def js_len(s):
    """字符串长度，对齐 JavaScript 的 `String.prototype.length`。

    JS 数的是 **UTF-16 码元**，而不是 Unicode 码点：一个 emoji（如 🔥，U+1F525）
    在 JS 里长度是 2，用 Python 的 len() 则是 1。
    项目的「项目简介」因子同时踩了两处 —— 它拿 20 字符当打分阈值，又把字符数
    直接印进报告。描述里只要有一个 emoji，两端就会分别显示 20 / 19，
    甚至落进不同档位、白白差出 1 分。
    """
    if not s:
        return 0
    # surrogatepass：JS 允许字符串含落单代理项（长度为 1），普通 encode 会直接抛错
    return len(s.encode('utf-16-le', 'surrogatepass')) // 2


def round1(v):
    return js_round(v, 1)


def ladder(value, steps, fallback=0):
    """按断点表做阶梯打分：[阈值, 得分]，阈值升序，取满足条件的最高档"""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return fallback
    score = fallback
    for threshold, points in steps:
        if value >= threshold:
            score = points
    return score


def log_scale(value, maximum, points):
    """对数刻度打分，用于 Star/Fork 这类长尾分布的指标"""
    if not value or value <= 0:
        return 0
    denom = math.log10(maximum + 1)
    return clamp((math.log10(value + 1) / denom) * points, 0, points)


def factor(key, label, value, points, max_points, note):
    return {'key': key, 'label': label, 'value': value,
            'points': round1(points), 'max': max_points, 'note': note}


def _sum_factors(arr):
    return sum(f['points'] for f in arr)


def compute_score(m):
    p, a, c, e, meta = m['popularity'], m['activity'], m['community'], m['engineering'], m['meta']

    # ---------- 1. 社区影响力 25 ----------
    star_pts = log_scale(p['stars'], 50000, 14)
    fork_pts = log_scale(p['forks'], 10000, 6)
    watch_pts = log_scale(p['watchers'], 2000, 5)
    influence = [
        factor('stars', 'Star 数', p['stars'], star_pts, 14, '按对数刻度换算，1 万星约得 85% 分值'),
        factor('forks', 'Fork 数', p['forks'], fork_pts, 6, '反映被二次开发/借鉴的活跃度'),
        factor('watchers', 'Watch 数', p['watchers'], watch_pts, 5, '持续关注者，比 Star 更能体现黏性'),
    ]

    # ---------- 2. 活跃程度 25 ----------
    # 注意：阶梯表按阈值升序书写，ladder 取「满足条件的最大阈值」对应档位；
    # 对于「越小越好」的指标（距今天数、关闭耗时），统一取负值后套用同一逻辑。
    days = float('inf') if a['daysSinceLastCommit'] is None else a['daysSinceLastCommit']
    recency_pts = ladder(-days, [(-730, 1), (-365, 3), (-180, 5), (-90, 7), (-30, 9), (-7, 10)], 0)
    freq_pts = ladder(a['commitsLast90'], [
        (0, 0), (1, 1), (3, 2), (10, 4), (30, 5.5), (60, 7), (120, 8),
    ])
    release_pts = ladder(a['releasesLastYear'], [(1, 3), (3, 5), (6, 6), (12, 7)],
                         2 if a['commitsLast90'] >= 20 else 0)
    activity = [
        factor('recency', '最近一次提交',
               '未知' if a['daysSinceLastCommit'] is None else f"{a['daysSinceLastCommit']} 天前",
               recency_pts, 10, '7 天内为满分，超过一年开始显著衰减'),
        factor('frequency', '近 90 天提交数', a['commitsLast90'], freq_pts, 8, '基于最近 100 次提交样本统计'),
        factor('release', '近一年发版次数', a['releasesLastYear'], release_pts, 7, '有稳定发版节奏说明项目在持续交付'),
    ]

    # ---------- 3. 维护质量 20 ----------
    issue = c['issueSample']
    close_pts = 3 if issue['closeRatio'] is None else ladder(
        issue['closeRatio'], [(0, 0), (0.2, 1), (0.4, 2.5), (0.6, 4), (0.75, 5), (0.9, 6)])
    backlog_per_hundred_stars = (p['openIssues'] / p['stars']) * 100 if p['stars'] > 0 else p['openIssues']
    backlog_pts = ladder(100 - backlog_per_hundred_stars, [(0, 0), (50, 1.5), (80, 3), (95, 4)]) \
        if p['stars'] >= 100 else ladder(-p['openIssues'], [(-20, 3), (-10, 4), (-5, 4)])
    health_pts = 3 if c['communityHealth'] is None else (c['communityHealth'] / 100) * 5
    readme_pts = 3 if meta['readmePresent'] else 0
    close_days = float('inf') if issue['avgIssueCloseDays'] is None else issue['avgIssueCloseDays']
    close_speed_pts = ladder(-close_days, [(-180, 0.5), (-60, 1), (-14, 1.5), (-3, 2)], 0)
    maintenance = [
        factor('closeRatio', 'Issue 关闭率',
               '无数据' if issue['closeRatio'] is None else f"{js_math_round(issue['closeRatio'] * 100)}%",
               close_pts, 6, '基于最近 100 条 Issue 采样'),
        factor('backlog', 'Issue 积压压力', p['openIssues'], backlog_pts, 4, '未关闭 Issue 相对 Star 规模的比例'),
        factor('communityHealth', 'GitHub 社区健康度',
               '无数据' if c['communityHealth'] is None else f"{c['communityHealth']}%",
               health_pts, 5, '来自 GitHub 官方 community/profile 接口'),
        factor('readme', 'README 文档', '已提供' if meta['readmePresent'] else '缺失',
               readme_pts, 3, '项目可读性的最低门槛'),
        factor('closeSpeed', '平均关闭耗时',
               '无数据' if issue['avgIssueCloseDays'] is None else f"{issue['avgIssueCloseDays']} 天",
               close_speed_pts, 2, '反映维护者响应速度'),
    ]

    # ---------- 4. 协作广度 15 ----------
    contributor_pts = ladder(c['contributorCount'], [
        (0, 0), (1, 0.5), (2, 1.5), (3, 2.5), (5, 3.5), (10, 5), (20, 6), (50, 7), (100, 8),
    ])
    bus_pts = 2 if c['busFactor'] is None else ladder(
        -c['busFactor'], [(-1, 0.5), (-0.9, 1), (-0.7, 2), (-0.5, 3), (-0.3, 4)])
    top3_pts = 1.5 if c['top3Share'] is None else ladder(
        -c['top3Share'], [(-1, 0.5), (-0.95, 1.5), (-0.8, 2.5), (-0.6, 3)])
    collaboration = [
        factor('contributors', '贡献者数量',
               f"{c['contributorCount']}{'+' if c['contributorCountCapped'] else ''}",
               contributor_pts, 8, '最多统计前 100 名贡献者'),
        factor('busFactor', '总线因子',
               '无数据' if c['busFactor'] is None else f"{js_math_round(c['busFactor'] * 100)}%",
               bus_pts, 4, '头号贡献者占全部提交的比例，越低越健康'),
        factor('top3Share', 'Top3 贡献者占比',
               '无数据' if c['top3Share'] is None else f"{js_math_round(c['top3Share'] * 100)}%",
               top3_pts, 3, '衡量核心开发力量是否过度集中'),
    ]

    # ---------- 5. 工程规范 15 ----------
    license_pts = 3 if meta['license'] and meta['license'] != 'NOASSERTION' else 0
    desc_pts = 2 if js_len(meta['description']) >= 20 else (1 if meta['description'] else 0)
    topic_pts = ladder(len(meta['topics']), [(1, 1), (3, 2)])
    docs_pts = 2 if (meta['homepage'] or meta['hasPages'] or meta['hasWiki'] or e['hasDocsDir']) else 0
    ci_pts = 3 if e['hasCi'] else 0
    test_pts = min(
        (1.5 if e['hasTests'] else 0) + (0.5 if e['hasBuildManifest'] else 0) +
        (0.5 if e['hasDocker'] else 0) + (0.5 if e['hasContributing'] else 0),
        2,
    )
    version_pts = 1 if a['latestVersionTag'] else 0
    engineering = [
        factor('license', '开源许可证', meta['license'] or '无', license_pts, 3, '无许可证意味着他人不能合法使用'),
        factor('description', '项目简介',
               f"{js_len(meta['description'])} 字符" if meta['description'] else '缺失',
               desc_pts, 2, '20 字符以上为满分'),
        factor('topics', 'Topics 标签', len(meta['topics']), topic_pts, 2, '有助于被检索和归类'),
        factor('docs', '文档站点/文档目录', '具备' if docs_pts else '无',
               docs_pts, 2, 'Homepage、GitHub Pages、Wiki 或 docs/ 目录'),
        factor('ci', 'CI 工作流', f"{e['workflowCount']} 个" if e['hasCi'] else '未配置',
               ci_pts, 3, '检出 .github/workflows'),
        factor('tests', '测试与工程化文件', js_round(test_pts, 1), min(test_pts, 2), 2,
               '测试目录、构建清单、Dockerfile、贡献指南'),
        factor('version', '版本标签', a['latestVersionTag'] or '无', version_pts, 1, '发布过 Release 说明有版本管理意识'),
    ]

    dimensions = [
        {'key': 'influence', 'name': '社区影响力', 'weight': 25, 'factors': influence,
         'score': round1(_sum_factors(influence))},
        {'key': 'activity', 'name': '活跃程度', 'weight': 25, 'factors': activity,
         'score': round1(_sum_factors(activity))},
        {'key': 'maintenance', 'name': '维护质量', 'weight': 20, 'factors': maintenance,
         'score': round1(_sum_factors(maintenance))},
        {'key': 'collaboration', 'name': '协作广度', 'weight': 15, 'factors': collaboration,
         'score': round1(_sum_factors(collaboration))},
        {'key': 'engineering', 'name': '工程规范', 'weight': 15, 'factors': engineering,
         'score': round1(_sum_factors(engineering))},
    ]

    total = round1(sum(d['score'] for d in dimensions))
    flags = build_flags(m)

    # 维护状态封顶：避免「已归档 / 已声明停止维护」的项目拿到高分推荐
    caps = []
    if meta['archived']:
        caps.append({'reason': '仓库已归档', 'cap': 45})
    if meta['disabled']:
        caps.append({'reason': '仓库已停用', 'cap': 20})
    if (m.get('maintenance') or {}).get('declared'):
        caps.append({'reason': 'README 声明进入维护/废弃状态', 'cap': 70})

    final_total = total
    for c_ in caps:
        final_total = min(final_total, c_['cap'])

    grade_info = next(g for g in GRADES if final_total >= g['min'])

    return {
        'total': round1(final_total),
        'rawTotal': total,
        'capped': final_total != total,
        'caps': caps,
        'gradeInfo': grade_info,
        'dimensions': [{**d, 'percent': round1((d['score'] / d['weight']) * 100)} for d in dimensions],
        'flags': flags,
        'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') +
        f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z',
    }


def build_flags(m):
    """风险与亮点识别：规则透明，前端以标签形式呈现"""
    meta, p, a, c, e = m['meta'], m['popularity'], m['activity'], m['community'], m['engineering']
    flags = []

    def push(level, title, detail):
        flags.append({'level': level, 'title': title, 'detail': detail})

    # 数据完整性优先说明：部分接口采集失败会让分数偏低，用户必须知道这一点，
    # 否则会把「取不到数据」误读成「项目不活跃」。
    failed = (m.get('diagnostics') or {}).get('failed') or []
    if failed:
        more = f' 等 {len(failed)} 项' if len(failed) > 4 else ''
        push('warn', f'数据不完整（{len(failed)} 项接口采集失败）',
             f"以下数据未能取到，相关维度可能被低估，建议稍后重试：{'；'.join(failed[:4])}{more}。")
    if (m.get('diagnostics') or {}).get('viaRelay'):
        push('info', '数据经备用通道获取',
             f"本次直连 GitHub 失败，数据经镜像通道（{m['diagnostics']['viaRelay']}）获取，仅含公开仓库信息。")

    if meta['archived']:
        push('danger', '仓库已归档', '作者已停止维护，总分被强制封顶，不建议用于生产项目。')
    if (m.get('maintenance') or {}).get('declared'):
        push('warning', '项目已宣布进入维护/废弃状态',
             f"README 中检测到「{'、'.join(m['maintenance']['keywords'])}」，"
             f"原文：{m['maintenance']['excerpt'] or '（略）'}")
    if a['daysSinceLastCommit'] is not None and a['daysSinceLastCommit'] > 365:
        push('danger', '超过一年没有提交',
             f"最近一次提交在 {a['daysSinceLastCommit']} 天前，需自行评估维护风险。")
    elif a['daysSinceLastCommit'] is not None and a['daysSinceLastCommit'] > 180:
        push('warning', '近期活跃度偏低', f"最近一次提交在 {a['daysSinceLastCommit']} 天前。")
    if not meta['license']:
        push('warning', '缺少开源许可证',
             '没有 License 的项目在法律上默认「保留所有权利」，企业使用需谨慎。')
    if e['hasCi'] is False:
        push('info', '未配置 CI', '仓库根目录未发现 .github/workflows，缺少自动化测试/构建保障。')
    # 纯文档/清单类仓库不适用「缺测试目录」的判定
    if e['hasTests'] is False and e['looksLikeCodeRepo'] is not False:
        push('info', '未发现测试目录', '根目录未发现 tests / __tests__ / spec 等测试目录或测试配置。')
    if c['busFactor'] is not None and c['busFactor'] > 0.85 and c['contributorCount'] >= 3:
        push('warning', '存在巴士因子风险',
             f"头号贡献者贡献了约 {js_math_round(c['busFactor'] * 100)}% 的提交，核心人员流失会显著影响项目。")
    if (c['issueSample']['closeRatio'] is not None and c['issueSample']['closeRatio'] < 0.4
            and c['issueSample']['issues'] >= 20):
        push('warning', 'Issue 积压明显',
             f"采样中 Issue 关闭率仅 {js_math_round(c['issueSample']['closeRatio'] * 100)}%，作者响应可能跟不上社区反馈。")
    if p['stars'] >= 3000 and a['daysSinceLastCommit'] is not None and a['daysSinceLastCommit'] > 270:
        push('warning', '高热度但低活跃', 'Star 数量可观但近期几乎停更，属于典型的「博物馆项目」，适合阅读借鉴而非依赖。')
    if meta['isFork']:
        push('info', '这是一个 Fork', '仓库派生自其他项目，原始贡献度不属于本仓库。')

    if p['stars'] >= 1000:
        push('success', '社区认可度高', f"已获得 {p['stars']:,} Star，处于同类项目前列。")
    if e['hasCi']:
        push('success', '具备 CI 流水线', f"检测到 {e['workflowCount']} 个 GitHub Actions 工作流。")
    if meta['license'] and meta['license'] != 'NOASSERTION':
        push('success', '许可证清晰', f"采用 {meta['license']}，商用与二次分发边界明确。")
    if a['releasesLastYear'] >= 6:
        push('success', '发版节奏稳定', f"近一年发布 {a['releasesLastYear']} 个版本。")
    if c['contributorCount'] >= 20:
        push('success', '协作生态健康',
             f"{c['contributorCount']}{'+' if c['contributorCountCapped'] else ''} 位贡献者参与建设。")

    return flags


def local_review(m, score):
    """本地启发式点评（无 AI Key 时的兜底，也作为 AI 结果的参照）"""
    meta, p, a, c = m['meta'], m['popularity'], m['activity'], m['community']
    dims = sorted(score['dimensions'], key=lambda d: -d['percent'])
    best, worst = dims[0], dims[-1]
    dangers = [f for f in score['flags'] if f['level'] == 'danger']
    warnings = [f for f in score['flags'] if f['level'] == 'warning']

    summary = (
        f"{meta['fullName']} 综合得分 {score['total']} 分"
        f"（{score['gradeInfo']['grade']} 级 · {score['gradeInfo']['label']}），"
        f"目前有 {p['stars']:,} Star、{p['forks']:,} Fork、"
        f"{c['contributorCount']}{'+' if c['contributorCountCapped'] else ''} 位贡献者。"
        f"表现最好的是「{best['name']}」（{best['percent']}%），短板在「{worst['name']}」（{worst['percent']}%）。"
        + ('' if a['daysSinceLastCommit'] is None
           else f"最近一次提交距今 {a['daysSinceLastCommit']} 天，近 90 天提交 {a['commitsLast90']} 次。")
        + (' 该仓库已被归档，请谨慎评估。' if meta['archived'] else '')
        + (' 另需注意：README 已声明项目进入维护或废弃状态，评分已据此封顶。'
           if (m.get('maintenance') or {}).get('declared') and not meta['archived'] else '')
    )

    pros = [f"{f['title']}：{f['detail']}" for f in score['flags'] if f['level'] == 'success']
    cons = [f"{f['title']}：{f['detail']}" for f in dangers + warnings]

    suggestions = []
    if not meta['license']:
        suggestions.append('尽快补充 LICENSE 文件，明确授权范围，这是开源项目被企业采用的前提。')
    if not m['engineering']['hasCi']:
        suggestions.append('接入 GitHub Actions 做自动化测试与构建，能显著降低回归风险。')
    if not m['engineering']['hasTests']:
        suggestions.append('补充单元测试目录与覆盖率门禁，提升长期可维护性。')
    if js_len(meta['description']) < 20:
        suggestions.append('完善仓库简介与 README，降低新用户的理解成本。')
    if len(meta['topics']) < 3:
        suggestions.append('补齐 Topics 标签，提升在 GitHub 搜索中的曝光。')
    if p['openIssues'] > 30:
        suggestions.append(
            f'当前有 {p["openIssues"]} 个待处理 Issue，建议做一轮分类归档并给长期未响应的 Issue 打上标记。')
    if a['releasesLastYear'] == 0:
        suggestions.append('建立版本与 Release 发布习惯，方便使用方锁定稳定版本。')
    if not suggestions:
        suggestions.append('各项指标均已达标，建议保持当前维护节奏，并把精力投入到文档与示例建设上。')
    if (m.get('maintenance') or {}).get('declared'):
        suggestions.insert(0, '该项目已声明进入维护/废弃状态，若要用于生产环境，建议同步规划替代方案与迁移路径。')

    tags = [score['gradeInfo']['label']]
    if p['stars'] >= 10000:
        tags.append('高热度')
    if a['daysSinceLastCommit'] is not None and a['daysSinceLastCommit'] <= 30:
        tags.append('活跃维护')
    if meta['archived']:
        tags.append('已归档')
    if c['contributorCount'] >= 20:
        tags.append('社区驱动')
    if c['contributorCount'] <= 3 and not meta['archived']:
        tags.append('个人项目')
    if m['languages']['list']:
        tags.append(f"主语言 {m['languages']['list'][0]['name']}")

    if meta['archived']:
        verdict = '不推荐：仓库已归档，仅适合作为参考资料阅读。'
    elif (m.get('maintenance') or {}).get('declared'):
        verdict = '谨慎推荐：项目已宣布进入维护/废弃状态，功能虽可用，但建议优先评估仍在活跃迭代的替代方案。'
    elif score['total'] >= 80:
        verdict = '强烈推荐：可直接用于生产环境或作为技术选型首选。'
    elif score['total'] >= 70:
        verdict = '推荐：整体健康，可放心引入，注意跟进其发版节奏。'
    elif score['total'] >= 60:
        verdict = '谨慎推荐：核心功能可用，但工程规范或维护活跃度存在明显短板。'
    else:
        verdict = '不推荐直接依赖：建议先评估替代方案，或做好自行维护的准备。'

    return {
        'source': 'local',
        'model': 'rule-based-engine',
        'score': score['total'],
        'summary': summary,
        'pros': pros or ['暂无明显突出的加分项。'],
        'cons': cons or ['未发现明显的风险信号。'],
        'suggestions': suggestions,
        'tags': tags,
        'verdict': verdict,
    }


def ai_review(m, score, api_key=None, base_url=None, model=None):
    """调用 OpenAI 兼容接口做点评（支持任意兼容 baseURL）"""
    key = api_key or os.environ.get('OPENAI_API_KEY') or os.environ.get('AI_API_KEY')
    if not key:
        return {**local_review(m, score), 'note': '未配置 AI Key，已回退本地规则引擎。'}

    base = (base_url or os.environ.get('OPENAI_BASE_URL') or os.environ.get('AI_BASE_URL')
            or 'https://api.openai.com/v1').rstrip('/')
    used_model = model or os.environ.get('AI_MODEL') or os.environ.get('OPENAI_MODEL') or 'gpt-4o-mini'

    compact = {
        '仓库': m['meta']['fullName'],
        '简介': m['meta']['description'],
        '主语言': m['meta']['nativeLanguage'],
        '许可证': m['meta']['license'],
        '是否归档': m['meta']['archived'],
        '维护状态': (f"README 已声明维护/废弃（关键词：{'、'.join(m['maintenance']['keywords'])}）"
                     if (m.get('maintenance') or {}).get('declared') else '正常'),
        'Star': m['popularity']['stars'],
        'Fork': m['popularity']['forks'],
        'Watcher': m['popularity']['watchers'],
        '未关闭Issue': m['popularity']['openIssues'],
        '最近提交距今天数': m['activity']['daysSinceLastCommit'],
        '近90天提交数': m['activity']['commitsLast90'],
        '近一年发版数': m['activity']['releasesLastYear'],
        '贡献者数': m['community']['contributorCount'],
        '总线因子': m['community']['busFactor'],
        'Issue关闭率': m['community']['issueSample']['closeRatio'],
        '社区健康度': m['community']['communityHealth'],
        '有CI': m['engineering']['hasCi'],
        '有测试目录': m['engineering']['hasTests'],
        '语言分布': [f"{l['name']} {l['percent']}%" for l in m['languages']['list'][:5]],
        '维度得分': [f"{d['name']} {d['score']}/{d['weight']}" for d in score['dimensions']],
        '规则引擎总分': score['total'],
        '风险信号': [f['title'] for f in score['flags'] if f['level'] != 'success'],
    }

    body = {
        'model': used_model,
        'temperature': 0.4,
        'messages': [
            {
                'role': 'system',
                'content':
                    '你是一位资深开源技术选型顾问。基于给定的仓库指标，给出专业、克制、有依据的评估。'
                    '不要编造指标之外的事实（例如不要声称你读过它的源码）。只输出 JSON，不要 Markdown 代码块。'
                    'JSON 字段：score(0-100 数字), summary(120 字内中文总评), pros(3-5 条中文优点数组), '
                    'cons(2-4 条中文风险数组), suggestions(3-5 条中文可执行建议数组), '
                    'tags(3-6 个中文短标签数组), verdict(一句话中文选型结论)。',
            },
            {'role': 'user', 'content': f'请评估以下 GitHub 仓库：\n'
                                        f'{_json.dumps(compact, ensure_ascii=False, indent=2)}'},
        ],
    }

    timeout = int(os.environ.get('AI_TIMEOUT_MS') or 45000)
    try:
        res = _post_json(f'{base}/chat/completions',
                         {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'},
                         body, timeout)
        if not res.ok:
            raise RuntimeError(f'AI 接口返回 {res.status}: {res.text()[:180]}')
        payload = res.json()
        content = (((payload or {}).get('choices') or [{}])[0].get('message') or {}).get('content') or ''
        parsed = _extract_json(content)
        if not parsed:
            raise RuntimeError('AI 返回内容无法解析为 JSON')

        fallback = local_review(m, score)
        return {
            'source': 'llm',
            'model': used_model,
            'score': clamp(parsed['score'], 0, 100) if isinstance(parsed.get('score'), (int, float))
            else score['total'],
            'summary': parsed.get('summary') or fallback['summary'],
            'pros': _as_array(parsed.get('pros'), fallback['pros']),
            'cons': _as_array(parsed.get('cons'), fallback['cons']),
            'suggestions': _as_array(parsed.get('suggestions'), fallback['suggestions']),
            'tags': _as_array(parsed.get('tags'), fallback['tags']),
            'verdict': parsed.get('verdict') or fallback['verdict'],
            'usage': payload.get('usage'),
        }
    except Exception as err:
        fallback = local_review(m, score)
        fallback['note'] = f'AI 调用失败（{err}），已回退本地规则引擎结果。'
        return fallback


def _post_json(url, headers, payload, timeout):
    """发一个带 JSON 体的 POST（proxy._do_request 只处理无体请求）"""
    from urllib.request import Request

    from .proxy import HttpResponse, _build_opener

    opener = _build_opener(None)
    data = _json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = Request(url, data=data, method='POST',
                  headers={**headers, 'Content-Length': str(len(data))})
    resp = opener.open(req, timeout=max(0.001, timeout / 1000.0))
    try:
        return HttpResponse(resp.status, resp.headers, resp.read(), resp.geturl())
    finally:
        resp.close()


def _as_array(v, fallback):
    if not isinstance(v, list):
        return fallback
    cleaned = [x.strip() for x in v if isinstance(x, str) and x.strip()]
    return cleaned or fallback


def _extract_json(text):
    if not text:
        return None
    fenced = re.search(r'```(?:json)?\s*([\s\S]*?)```', text, re.I)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find('{'), candidate.rfind('}')
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return _json.loads(candidate[start:end + 1])
    except Exception:
        return None
