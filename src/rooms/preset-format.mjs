/**
 * preset-format —— preset 引擎块的**唯一**文本事实（A2-1，2026-10-30）
 *
 * 为什么独立成房间：这段代码决定 preset YAML 里的「压缩后端那一块」长什么样 ——
 * 注释文本、键顺序、缩进、引号规则都是**给人看的契约**（契约文档 §2.9「preset 块」）。
 * 它同时被两个房间使用：
 *   · R13 install（scripts/install.mjs）—— 安装器写块；
 *   · R11 ui-host（src/ui.mjs）—— 设置页保存时按实际值渲染。
 *
 * 在此之前 ui-host 反向 import 了 scripts/install.mjs（R-A 唯一红点：src → scripts）。
 * 搬家只搬位置，**一个字节的块格式都不许变** —— 本文件的每个字符都是逐行搬来的。
 *
 * 兼容：scripts/install.mjs 保留同名 re-export（test/ui.test.mjs、test/ui-config.test.mjs、
 * test/install-link.test.mjs 都从那里取）。删掉那行 re-export **不会**让文件加载失败，
 * 而是让 `ui`(38/16)、`ui-config`(8/5)、`ui-security`(19/6) 的用例在**运行期**红
 * （导入得到 `undefined`，不是 SyntaxError）；`install-link` 仍 29/0。
 */

export const PKG_NAME = "dsh-gokifu-compact";
export const ENTRY_ID = "gokifu-compact";

/**
 * 找到 `- id: compaction-basic` 那一块并整块替换（按缩进判断块边界）。
 * @returns 新文本；找不到返回 null
 */
export function replaceCompactionBlock(text, blockLines) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const startPattern = /^(\s*)- id: compaction-basic\s*$/;
  let start = -1;
  let foundIndent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const m = startPattern.exec(lines[i]);
    if (m) {
      start = i;
      foundIndent = m[1];
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (/^\s*#/.test(line)) continue;
    const lead = (/^\s*/.exec(line)[0] ?? "").length;
    if (lead === foundIndent.length && /^-\s/.test(line.trim())) {
      end = i;
      break;
    }
    if (lead < foundIndent.length) {
      end = i;
      break;
    }
  }
  const replacement = blockLines.map((line) => foundIndent + line);
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

/** 我们的引擎块（不含缩进，缩进由 replaceCompactionBlock 加）。 */
export function engineBlock() {
  return [
    `# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。`,
    `#   替换掉原来的 @deepseek-ai/dsh-compaction-basic —— 两者会抢同一个 ctx.compaction。`,
    `#   回滚：dsh-gokifu-compact revert   （恢复 .bak-before-gokifu-* 备份）`,
    `- id: ${ENTRY_ID}`,
    `  name: '${PKG_NAME}/engine'`,
    `  config:`,
    `    auto: true                # 自动压缩：继承基类的 between-step 压力触发`,
    `    thresholdRatio: 0.45      # 压力闸：min(窗口×0.45, 窗口−输出预留−64K)`,
    `    firstFoldRatio: 0.30      # 首折阈值：只作用于本会话第一次 fold（0 = 关闭）`,
    `    headroomTokens: 65536`,
    `    retainRatio: 0.16         # 逐字保留的近期尾部`,
    `    growthFloorTokens: 40000  # 增长闸：距上次 fold 至少新增这么多 token`,
    `    minFoldTokens: 8000`,
    `    summaryMode: hybrid       # hybrid | rules（零模型调用）| llm`,
    `    summarizationProvider: '' # 留空 = 跟随当前路由`,
    `    summarizationModel: ''    # 想用免费模型，先确认 provider 模型表里有那个 id`,
    `    hotLedger: true`,
    `    hotLedgerMaxTokens: 500`,
    `    hotLedgerMarkers: semantic`,
    `    hotLedgerReplace: true`,
    `    transposition: true`,
    `    tier2After: 8`,
  ];
}

/**
 * 解析 preset 文本里我们那一块（`- id: gokifu-compact`）。
 * raw 覆盖「紧贴 id 行的注释 + 整块」，这样替换时注释不会重复。
 */
export function parseEngineBlock(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const idRe = new RegExp("^(\\s*)- id: " + ENTRY_ID + "\\s*$");
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const m = idRe.exec(lines[i]);
    if (m) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start < 0) return null;
  // 往上吞掉同缩进的注释行（它们属于这一块）
  let first = start;
  while (first > 0 && /^\s*#/.test(lines[first - 1]) && /^(\s*)/.exec(lines[first - 1])[1].length === indent.length) first -= 1;
  // 往下找块尾：同缩进的下一个条目，或更浅的层级
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const lead = /^(\s*)/.exec(line)[1].length;
    if (lead <= indent.length && /^-\s/.test(line.trim())) {
      end = i;
      break;
    }
    if (lead < indent.length) {
      end = i;
      break;
    }
  }
  const raw = lines.slice(first, end).join("\n");
  const config = {};
  let inConfig = false;
  for (const line of lines.slice(start + 1, end)) {
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = parseScalar(m[2]);
    if (value !== undefined) config[m[1]] = value;
  }
  return { indent, raw, config, commentLines: [] };
}

function parseScalar(raw) {
  const text = String(raw).replace(/\s+#.*$/, "").trim();
  if (text.length === 0) return undefined;
  if (/^'.*'$/.test(text) || /^".*"$/.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function formatScalar(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return "''";
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9._/-]+$/.test(text)) return "'" + text + "'";
  return "'" + text.replace(/'/g, "''") + "'";
}

/** 每个键后面带的短注释（写回 preset 时保留可读性）。 */
export const KEY_COMMENTS = {
  auto: "自动压缩（between-step 压力触发）",
  thresholdRatio: "压力闸：min(窗口×该值, 窗口−输出预留−余量)",
  headroomTokens: "路由输出预留之外的额外余量",
  retainRatio: "逐字保留的近期尾部",
  growthFloorTokens: "增长闸：距上次 fold 增至该值才再次 fold",
  minFoldTokens: "被遮蔽内容少于该值不 fold",
  summaryMode: "hybrid | rules（零模型调用）| llm",
  summarizationProvider: "留空 = 跟随当前路由",
  summarizationModel: "留空 = 跟随当前路由",
  maxTokens: "摘要输出上限",
  hotLedger: "每步注入失败清单",
  hotLedgerMaxTokens: "清单 token 上限",
  hotLedgerMarkers: "semantic | terse | off",
  hotLedgerReplace: "就地替换旧清单（surface 永远一条）",
  transposition: "置换检测",
  tier2After: "checkpoint 超过该值合并最老的两段",
  graphDir: "棋谱目录；留空 = <DSH_HOME>/chess-context",
  worldHashMaxFiles: "世界状态哈希最多 stat 多少文件",
};

/**
 * 用一份配置对象渲染我们那一块（含注释）。缩进由调用方给。
 * 与 engineBlock() 的区别：后者是固定模板（安装器用），这个按实际值渲染（UI 保存用）。
 */
export function renderEngineBlock(config, indent = "") {
  const lines = [
    "# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。",
    "#   替换掉原来的 @deepseek-ai/dsh-compaction-basic —— 两者会抢同一个 ctx.compaction。",
    "#   回滚：dsh-gokifu-compact revert   （恢复 .bak-before-gokifu-* 备份）",
    "- id: " + ENTRY_ID,
    "  name: '" + PKG_NAME + "/engine'",
    "  config:",
  ];
  for (const [key, value] of Object.entries(config ?? {})) {
    const note = KEY_COMMENTS[key];
    const pad = " ".repeat(Math.max(1, 20 - key.length));
    lines.push("    " + key + ": " + formatScalar(value) + (note ? pad + "# " + note : ""));
  }
  return lines.map((line) => indent + line).join("\n");
}
