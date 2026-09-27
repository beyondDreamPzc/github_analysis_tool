'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 轻量 .env 加载（零依赖，替代 dotenv）。
 *
 * 语义：
 *   - **已存在的环境变量优先**，不覆盖 —— 便于容器 / CI 用真实环境变量覆盖文件配置；
 *   - 去掉值两端的空白；
 *   - 去掉「成对包裹」的引号；
 *   - 剥离值后面的行尾注释，但只认「空白 + #」，
 *     避免误伤值本身含 # 的情况（URL fragment、密码等）。
 *
 * 为什么要专门做这些清理：
 *   手填 Token 时最高频的失效原因不是 token 错，而是**值写脏了** ——
 *   末尾多一个空格、粘贴时带上了引号、顺手在后面写了句注释。
 *   这些情况下程序只会报 401 / 配额没变，极难联想到是配置文件的问题。
 */

/** 把 .env 文本解析成键值对象（抽成独立函数以便单测） */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;

    let value = m[2].trim();
    // 行尾注释：`KEY=value  # 说明` → value。只认「空白 + #」，不动 `KEY=a#b`
    const hash = value.search(/\s#/);
    if (hash !== -1) value = value.slice(0, hash).trim();
    // 仅当引号成对包裹时剥离，避免把值里本就不配对的引号也吃掉
    const q = value[0];
    if ((q === '"' || q === "'") && value.length > 1 && value.endsWith(q)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * 加载 .env 到 process.env。
 * @param {string} [dir] 项目根目录，默认取本文件的上层目录
 * @returns {{file: string, exists: boolean, applied: string[], skipped: string[]}}
 */
function loadDotEnv(dir) {
  const file = path.join(dir || path.join(__dirname, '..'), '.env');
  if (!fs.existsSync(file)) return { file, exists: false, applied: [], skipped: [] };

  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key]) { skipped.push(key); continue; } // 环境变量优先
    process.env[key] = value;
    applied.push(key);
  }
  return { file, exists: true, applied, skipped };
}

module.exports = { parseEnv, loadDotEnv };
