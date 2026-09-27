'use strict';

/**
 * 健康度评分引擎
 *
 * 设计原则：可解释。每个分数都能回溯到具体的原始数据与阈值，
 * 前端会把每个「子因子」的得分与说明一并展示，避免变成黑盒评分。
 *
 * 五个维度（满分 100）：
 *   1. 社区影响力 influence    25 分 —— Star / Fork / Watch
 *   2. 活跃程度   activity     25 分 —— 最近提交、提交频次、发版节奏
 *   3. 维护质量   maintenance  20 分 —— Issue 处理、社区健康度、文档
 *   4. 协作广度   collaboration 15 分 —— 贡献者规模、总线因子
 *   5. 工程规范   engineering  15 分 —— License、CI、测试、工程文件
 */

const GRADES = [
  { min: 90, grade: 'S', label: '卓越', color: '#7c3aed' },
  { min: 80, grade: 'A', label: '优秀', color: '#16a34a' },
  { min: 70, grade: 'B', label: '良好', color: '#0ea5e9' },
  { min: 60, grade: 'C', label: '一般', color: '#f59e0b' },
  { min: 0, grade: 'D', label: '待改进', color: '#ef4444' },
];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v, d = 1) => +Number(v).toFixed(d);

/** 按断点表做阶梯打分：[阈值, 得分]，阈值升序，取满足条件的最高档 */
function ladder(value, steps, fallback = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  let score = fallback;
  for (const [threshold, points] of steps) {
    if (value >= threshold) score = points;
  }
  return score;
}

/** 对数刻度打分，用于 Star/Fork 这类长尾分布的指标 */
function logScale(value, max, points) {
  if (!value || value <= 0) return 0;
  const denom = Math.log10(max + 1);
  return clamp((Math.log10(value + 1) / denom) * points, 0, points);
}

function factor(key, label, value, points, max, note) {
  return { key, label, value, points: round(points, 1), max, note };
}

function computeScore(m) {
  const { popularity: p, activity: a, community: c, engineering: e, meta } = m;

  /* ---------- 1. 社区影响力 25 ---------- */
  const starPts = logScale(p.stars, 50000, 14);
  const forkPts = logScale(p.forks, 10000, 6);
  const watchPts = logScale(p.watchers, 2000, 5);
  const influence = [
    factor('stars', 'Star 数', p.stars, starPts, 14, '按对数刻度换算，1 万星约得 85% 分值'),
    factor('forks', 'Fork 数', p.forks, forkPts, 6, '反映被二次开发/借鉴的活跃度'),
    factor('watchers', 'Watch 数', p.watchers, watchPts, 5, '持续关注者，比 Star 更能体现黏性'),
  ];

  /* ---------- 2. 活跃程度 25 ---------- */
  // 注意：阶梯表按阈值升序书写，ladder 取「满足条件的最大阈值」对应档位；
  // 对于「越小越好」的指标（距今天数、关闭耗时），统一取负值后套用同一逻辑。
  const days = a.daysSinceLastCommit === null ? Infinity : a.daysSinceLastCommit;
  const recencyPts = ladder(-days, [[-730, 1], [-365, 3], [-180, 5], [-90, 7], [-30, 9], [-7, 10]], 0);
  const freqPts = ladder(a.commitsLast90, [
    [0, 0], [1, 1], [3, 2], [10, 4], [30, 5.5], [60, 7], [120, 8],
  ]);
  const releasePts = ladder(a.releasesLastYear, [[1, 3], [3, 5], [6, 6], [12, 7]], a.commitsLast90 >= 20 ? 2 : 0);
  const activity = [
    factor('recency', '最近一次提交', a.daysSinceLastCommit === null ? '未知' : `${a.daysSinceLastCommit} 天前`, recencyPts, 10, '7 天内为满分，超过一年开始显著衰减'),
    factor('frequency', '近 90 天提交数', a.commitsLast90, freqPts, 8, '基于最近 100 次提交样本统计'),
    factor('release', '近一年发版次数', a.releasesLastYear, releasePts, 7, '有稳定发版节奏说明项目在持续交付'),
  ];

  /* ---------- 3. 维护质量 20 ---------- */
  const issue = c.issueSample;
  const closePts = issue.closeRatio === null
    ? 3
    : ladder(issue.closeRatio, [[0, 0], [0.2, 1], [0.4, 2.5], [0.6, 4], [0.75, 5], [0.9, 6]]);
  const backlogPerHundredStars = p.stars > 0 ? (p.openIssues / p.stars) * 100 : p.openIssues;
  const backlogPts = p.stars >= 100
    ? ladder(100 - backlogPerHundredStars, [[0, 0], [50, 1.5], [80, 3], [95, 4]])
    : ladder(-p.openIssues, [[-20, 3], [-10, 4], [-5, 4]]);
  const healthPts = c.communityHealth === null ? 3 : (c.communityHealth / 100) * 5;
  const readmePts = meta.readmePresent ? 3 : 0;
  const closeDays = issue.avgIssueCloseDays === null ? Infinity : issue.avgIssueCloseDays;
  const closeSpeedPts = ladder(-closeDays, [[-180, 0.5], [-60, 1], [-14, 1.5], [-3, 2]], 0);
  const maintenance = [
    factor('closeRatio', 'Issue 关闭率', issue.closeRatio === null ? '无数据' : `${Math.round(issue.closeRatio * 100)}%`, closePts, 6, '基于最近 100 条 Issue 采样'),
    factor('backlog', 'Issue 积压压力', p.openIssues, backlogPts, 4, '未关闭 Issue 相对 Star 规模的比例'),
    factor('communityHealth', 'GitHub 社区健康度', c.communityHealth === null ? '无数据' : `${c.communityHealth}%`, healthPts, 5, '来自 GitHub 官方 community/profile 接口'),
    factor('readme', 'README 文档', meta.readmePresent ? '已提供' : '缺失', readmePts, 3, '项目可读性的最低门槛'),
    factor('closeSpeed', '平均关闭耗时', issue.avgIssueCloseDays === null ? '无数据' : `${issue.avgIssueCloseDays} 天`, closeSpeedPts, 2, '反映维护者响应速度'),
  ];

  /* ---------- 4. 协作广度 15 ---------- */
  const contributorPts = ladder(c.contributorCount, [
    [0, 0], [1, 0.5], [2, 1.5], [3, 2.5], [5, 3.5], [10, 5], [20, 6], [50, 7], [100, 8],
  ]);
  const busPts = c.busFactor === null ? 2 : ladder(-c.busFactor, [[-1, 0.5], [-0.9, 1], [-0.7, 2], [-0.5, 3], [-0.3, 4]]);
  const top3Pts = c.top3Share === null ? 1.5 : ladder(-c.top3Share, [[-1, 0.5], [-0.95, 1.5], [-0.8, 2.5], [-0.6, 3]]);
  const collaboration = [
    factor('contributors', '贡献者数量', `${c.contributorCount}${c.contributorCountCapped ? '+' : ''}`, contributorPts, 8, '最多统计前 100 名贡献者'),
    factor('busFactor', '总线因子', c.busFactor === null ? '无数据' : `${Math.round(c.busFactor * 100)}%`, busPts, 4, '头号贡献者占全部提交的比例，越低越健康'),
    factor('top3Share', 'Top3 贡献者占比', c.top3Share === null ? '无数据' : `${Math.round(c.top3Share * 100)}%`, top3Pts, 3, '衡量核心开发力量是否过度集中'),
  ];

  /* ---------- 5. 工程规范 15 ---------- */
  const licensePts = meta.license && meta.license !== 'NOASSERTION' ? 3 : 0;
  const descPts = (meta.description || '').length >= 20 ? 2 : meta.description ? 1 : 0;
  const topicPts = ladder(meta.topics.length, [[1, 1], [3, 2]]);
  const docsPts = meta.homepage || meta.hasPages || meta.hasWiki || e.hasDocsDir ? 2 : 0;
  const ciPts = e.hasCi ? 3 : 0;
  const testPts = Math.min(
    (e.hasTests ? 1.5 : 0) + (e.hasBuildManifest ? 0.5 : 0) +
      (e.hasDocker ? 0.5 : 0) + (e.hasContributing ? 0.5 : 0),
    2
  );
  const versionPts = a.latestVersionTag ? 1 : 0;
  const engineering = [
    factor('license', '开源许可证', meta.license || '无', licensePts, 3, '无许可证意味着他人不能合法使用'),
    factor('description', '项目简介', meta.description ? `${meta.description.length} 字符` : '缺失', descPts, 2, '20 字符以上为满分'),
    factor('topics', 'Topics 标签', meta.topics.length, topicPts, 2, '有助于被检索和归类'),
    factor('docs', '文档站点/文档目录', docsPts ? '具备' : '无', docsPts, 2, 'Homepage、GitHub Pages、Wiki 或 docs/ 目录'),
    factor('ci', 'CI 工作流', e.hasCi ? `${e.workflowCount} 个` : '未配置', ciPts, 3, '检出 .github/workflows'),
    factor('tests', '测试与工程化文件', round(testPts, 1), Math.min(testPts, 2), 2, '测试目录、构建清单、Dockerfile、贡献指南'),
    factor('version', '版本标签', a.latestVersionTag || '无', versionPts, 1, '发布过 Release 说明有版本管理意识'),
  ];

  const dimensions = [
    { key: 'influence', name: '社区影响力', weight: 25, factors: influence, score: round(sum(influence), 1) },
    { key: 'activity', name: '活跃程度', weight: 25, factors: activity, score: round(sum(activity), 1) },
    { key: 'maintenance', name: '维护质量', weight: 20, factors: maintenance, score: round(sum(maintenance), 1) },
    { key: 'collaboration', name: '协作广度', weight: 15, factors: collaboration, score: round(sum(collaboration), 1) },
    { key: 'engineering', name: '工程规范', weight: 15, factors: engineering, score: round(sum(engineering), 1) },
  ];

  const total = round(dimensions.reduce((acc, d) => acc + d.score, 0), 1);
  const flags = buildFlags(m);

  // 维护状态封顶：避免「已归档 / 已声明停止维护」的项目拿到高分推荐
  const caps = [];
  if (meta.archived) caps.push({ reason: '仓库已归档', cap: 45 });
  if (meta.disabled) caps.push({ reason: '仓库已停用', cap: 20 });
  if (m.maintenance?.declared) caps.push({ reason: 'README 声明进入维护/废弃状态', cap: 70 });

  let finalTotal = total;
  for (const c of caps) finalTotal = Math.min(finalTotal, c.cap);

  return {
    total: round(finalTotal, 1),
    rawTotal: total,
    capped: finalTotal !== total,
    caps,
    gradeInfo: GRADES.find((g) => finalTotal >= g.min),
    dimensions: dimensions.map((d) => ({
      ...d,
      percent: round((d.score / d.weight) * 100, 1),
    })),
    flags,
    generatedAt: new Date().toISOString(),
  };
}

const sum = (arr) => arr.reduce((a, f) => a + f.points, 0);

/** 风险与亮点识别：规则透明，前端以标签形式呈现 */
function buildFlags(m) {
  const { meta, popularity: p, activity: a, community: c, engineering: e } = m;
  const flags = [];
  const push = (level, title, detail) => flags.push({ level, title, detail });

  // 数据完整性优先说明：部分接口采集失败会让分数偏低，用户必须知道这一点，
  // 否则会把「取不到数据」误读成「项目不活跃」。
  const failed = m.diagnostics?.failed || [];
  if (failed.length) {
    push(
      'warn',
      `数据不完整（${failed.length} 项接口采集失败）`,
      `以下数据未能取到，相关维度可能被低估，建议稍后重试：${failed.slice(0, 4).join('；')}`
        + `${failed.length > 4 ? ` 等 ${failed.length} 项` : ''}。`
    );
  }
  if (m.diagnostics?.viaRelay) {
    push('info', '数据经备用通道获取', `本次直连 GitHub 失败，数据经镜像通道（${m.diagnostics.viaRelay}）获取，仅含公开仓库信息。`);
  }

  if (meta.archived) push('danger', '仓库已归档', '作者已停止维护，总分被强制封顶，不建议用于生产项目。');
  if (m.maintenance?.declared) {
    push('warning', '项目已宣布进入维护/废弃状态', `README 中检测到「${m.maintenance.keywords.join('、')}」，原文：${m.maintenance.excerpt || '（略）'}`);
  }
  if (a.daysSinceLastCommit !== null && a.daysSinceLastCommit > 365) {
    push('danger', '超过一年没有提交', `最近一次提交在 ${a.daysSinceLastCommit} 天前，需自行评估维护风险。`);
  } else if (a.daysSinceLastCommit !== null && a.daysSinceLastCommit > 180) {
    push('warning', '近期活跃度偏低', `最近一次提交在 ${a.daysSinceLastCommit} 天前。`);
  }
  if (!meta.license) push('warning', '缺少开源许可证', '没有 License 的项目在法律上默认「保留所有权利」，企业使用需谨慎。');
  if (e.hasCi === false) push('info', '未配置 CI', '仓库根目录未发现 .github/workflows，缺少自动化测试/构建保障。');
  // 纯文档/清单类仓库不适用「缺测试目录」的判定
  if (e.hasTests === false && e.looksLikeCodeRepo !== false) {
    push('info', '未发现测试目录', '根目录未发现 tests / __tests__ / spec 等测试目录或测试配置。');
  }
  if (c.busFactor !== null && c.busFactor > 0.85 && c.contributorCount >= 3) {
    push('warning', '存在巴士因子风险', `头号贡献者贡献了约 ${Math.round(c.busFactor * 100)}% 的提交，核心人员流失会显著影响项目。`);
  }
  if (c.issueSample.closeRatio !== null && c.issueSample.closeRatio < 0.4 && c.issueSample.issues >= 20) {
    push('warning', 'Issue 积压明显', `采样中 Issue 关闭率仅 ${Math.round(c.issueSample.closeRatio * 100)}%，作者响应可能跟不上社区反馈。`);
  }
  if (p.stars >= 3000 && a.daysSinceLastCommit !== null && a.daysSinceLastCommit > 270) {
    push('warning', '高热度但低活跃', 'Star 数量可观但近期几乎停更，属于典型的「博物馆项目」，适合阅读借鉴而非依赖。');
  }
  if (meta.isFork) push('info', '这是一个 Fork', '仓库派生自其他项目，原始贡献度不属于本仓库。');

  if (p.stars >= 1000) push('success', '社区认可度高', `已获得 ${p.stars.toLocaleString()} Star，处于同类项目前列。`);
  if (e.hasCi) push('success', '具备 CI 流水线', `检测到 ${e.workflowCount} 个 GitHub Actions 工作流。`);
  if (meta.license && meta.license !== 'NOASSERTION') push('success', '许可证清晰', `采用 ${meta.license}，商用与二次分发边界明确。`);
  if (a.releasesLastYear >= 6) push('success', '发版节奏稳定', `近一年发布 ${a.releasesLastYear} 个版本。`);
  if (c.contributorCount >= 20) push('success', '协作生态健康', `${c.contributorCount}${c.contributorCountCapped ? '+' : ''} 位贡献者参与建设。`);

  return flags;
}

/**
 * 本地启发式点评（无 AI Key 时的兜底，也作为 AI 结果的参照）
 */
function localReview(m, score) {
  const { meta, popularity: p, activity: a, community: c } = m;
  const dims = [...score.dimensions].sort((x, y) => y.percent - x.percent);
  const best = dims[0];
  const worst = dims[dims.length - 1];
  const dangers = score.flags.filter((f) => f.level === 'danger');
  const warnings = score.flags.filter((f) => f.level === 'warning');

  const summary =
    `${meta.fullName} 综合得分 ${score.total} 分（${score.gradeInfo.grade} 级 · ${score.gradeInfo.label}），` +
    `目前有 ${p.stars.toLocaleString()} Star、${p.forks.toLocaleString()} Fork、` +
    `${c.contributorCount}${c.contributorCountCapped ? '+' : ''} 位贡献者。` +
    `表现最好的是「${best.name}」（${best.percent}%），短板在「${worst.name}」（${worst.percent}%）。` +
    (a.daysSinceLastCommit === null
      ? ''
      : `最近一次提交距今 ${a.daysSinceLastCommit} 天，近 90 天提交 ${a.commitsLast90} 次。`) +
    (meta.archived ? ' 该仓库已被归档，请谨慎评估。' : '') +
    (m.maintenance?.declared && !meta.archived
      ? ' 另需注意：README 已声明项目进入维护或废弃状态，评分已据此封顶。'
      : '');

  const pros = score.flags.filter((f) => f.level === 'success').map((f) => `${f.title}：${f.detail}`);
  const cons = [...dangers, ...warnings].map((f) => `${f.title}：${f.detail}`);

  const suggestions = [];
  if (!meta.license) suggestions.push('尽快补充 LICENSE 文件，明确授权范围，这是开源项目被企业采用的前提。');
  if (!m.engineering.hasCi) suggestions.push('接入 GitHub Actions 做自动化测试与构建，能显著降低回归风险。');
  if (!m.engineering.hasTests) suggestions.push('补充单元测试目录与覆盖率门禁，提升长期可维护性。');
  if ((meta.description || '').length < 20) suggestions.push('完善仓库简介与 README，降低新用户的理解成本。');
  if (meta.topics.length < 3) suggestions.push('补齐 Topics 标签，提升在 GitHub 搜索中的曝光。');
  if (p.openIssues > 30) suggestions.push(`当前有 ${p.openIssues} 个待处理 Issue，建议做一轮分类归档并给长期未响应的 Issue 打上标记。`);
  if (a.releasesLastYear === 0) suggestions.push('建立版本与 Release 发布习惯，方便使用方锁定稳定版本。');
  if (suggestions.length === 0) suggestions.push('各项指标均已达标，建议保持当前维护节奏，并把精力投入到文档与示例建设上。');
  if (m.maintenance?.declared) suggestions.unshift('该项目已声明进入维护/废弃状态，若要用于生产环境，建议同步规划替代方案与迁移路径。');

  const tags = [];
  tags.push(score.gradeInfo.label);
  if (p.stars >= 10000) tags.push('高热度');
  if (a.daysSinceLastCommit !== null && a.daysSinceLastCommit <= 30) tags.push('活跃维护');
  if (meta.archived) tags.push('已归档');
  if (c.contributorCount >= 20) tags.push('社区驱动');
  if (c.contributorCount <= 3 && !meta.archived) tags.push('个人项目');
  if (m.languages.list[0]) tags.push(`主语言 ${m.languages.list[0].name}`);

  const verdict = meta.archived
    ? '不推荐：仓库已归档，仅适合作为参考资料阅读。'
    : m.maintenance?.declared
      ? '谨慎推荐：项目已宣布进入维护/废弃状态，功能虽可用，但建议优先评估仍在活跃迭代的替代方案。'
      : score.total >= 80
        ? '强烈推荐：可直接用于生产环境或作为技术选型首选。'
        : score.total >= 70
          ? '推荐：整体健康，可放心引入，注意跟进其发版节奏。'
          : score.total >= 60
            ? '谨慎推荐：核心功能可用，但工程规范或维护活跃度存在明显短板。'
            : '不推荐直接依赖：建议先评估替代方案，或做好自行维护的准备。';

  return {
    source: 'local',
    model: 'rule-based-engine',
    score: score.total,
    summary,
    pros: pros.length ? pros : ['暂无明显突出的加分项。'],
    cons: cons.length ? cons : ['未发现明显的风险信号。'],
    suggestions,
    tags,
    verdict,
  };
}

/**
 * 调用 OpenAI 兼容接口做点评（支持任意兼容 baseURL：OpenAI / DeepSeek / 通义 / 本地 vLLM 等）
 */
async function aiReview(m, score, { apiKey, baseUrl, model } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (!key) {
    return { ...localReview(m, score), note: '未配置 AI Key，已回退本地规则引擎。' };
  }
  const base = (baseUrl || process.env.OPENAI_BASE_URL || process.env.AI_BASE_URL || 'https://api.openai.com/v1')
    .replace(/\/+$/, '');
  const usedModel = model || process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const compact = {
    仓库: m.meta.fullName,
    简介: m.meta.description,
    主语言: m.meta.nativeLanguage,
    许可证: m.meta.license,
    是否归档: m.meta.archived,
    维护状态: m.maintenance?.declared
      ? `README 已声明维护/废弃（关键词：${m.maintenance.keywords.join('、')}）`
      : '正常',
    Star: m.popularity.stars,
    Fork: m.popularity.forks,
    Watcher: m.popularity.watchers,
    未关闭Issue: m.popularity.openIssues,
    最近提交距今天数: m.activity.daysSinceLastCommit,
    近90天提交数: m.activity.commitsLast90,
    近一年发版数: m.activity.releasesLastYear,
    贡献者数: m.community.contributorCount,
    总线因子: m.community.busFactor,
    Issue关闭率: m.community.issueSample.closeRatio,
    社区健康度: m.community.communityHealth,
    有CI: m.engineering.hasCi,
    有测试目录: m.engineering.hasTests,
    语言分布: m.languages.list.slice(0, 5).map((l) => `${l.name} ${l.percent}%`),
    维度得分: score.dimensions.map((d) => `${d.name} ${d.score}/${d.weight}`),
    规则引擎总分: score.total,
    风险信号: score.flags.filter((f) => f.level !== 'success').map((f) => f.title),
  };

  const body = {
    model: usedModel,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content:
          '你是一位资深开源技术选型顾问。基于给定的仓库指标，给出专业、克制、有依据的评估。' +
          '不要编造指标之外的事实（例如不要声称你读过它的源码）。只输出 JSON，不要 Markdown 代码块。' +
          'JSON 字段：score(0-100 数字), summary(120 字内中文总评), pros(3-5 条中文优点数组), ' +
          'cons(2-4 条中文风险数组), suggestions(3-5 条中文可执行建议数组), ' +
          'tags(3-6 个中文短标签数组), verdict(一句话中文选型结论)。',
      },
      { role: 'user', content: `请评估以下 GitHub 仓库：\n${JSON.stringify(compact, null, 2)}` },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 45000));
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 接口返回 ${res.status}: ${text.slice(0, 180)}`);
    }
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(content);
    if (!parsed) throw new Error('AI 返回内容无法解析为 JSON');

    const fallback = localReview(m, score);
    return {
      source: 'llm',
      model: usedModel,
      score: typeof parsed.score === 'number' ? clamp(parsed.score, 0, 100) : score.total,
      summary: parsed.summary || fallback.summary,
      pros: asArray(parsed.pros, fallback.pros),
      cons: asArray(parsed.cons, fallback.cons),
      suggestions: asArray(parsed.suggestions, fallback.suggestions),
      tags: asArray(parsed.tags, fallback.tags),
      verdict: parsed.verdict || fallback.verdict,
      usage: payload?.usage || null,
    };
  } catch (err) {
    const fallback = localReview(m, score);
    fallback.note = `AI 调用失败（${err.message}），已回退本地规则引擎结果。`;
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function asArray(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const cleaned = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return cleaned.length ? cleaned : fallback;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

module.exports = { computeScore, localReview, aiReview, GRADES };
