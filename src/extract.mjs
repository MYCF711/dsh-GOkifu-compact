/**
 * extract.mjs —— 从会话事件里抽取「意图 / 动作 / 约束」
 *
 * 全部是启发式，但必须**确定性**：同样的输入永远同样的输出，
 * 否则图不可复现、单测没法写。
 */

import { norm } from "./graph.mjs";

const INTENT_HINT_RE = /我要|我想|我将|接下来|下一步|先|然后|我会|准备|计划|先把|改成|let me|I'll|I will|next|first/i;

/**
 * 去掉「计划：」「我打算」「接下来我要」这类引导语 —— 它们不携带信息，
 * 却会让热上下文里的每一行都以同样的词开头（实测：8 条死路全以「计划：」开头，
 * 模型续跑时反而抓不到关键词）。
 */
const INTENT_PREFIX_RE = /^(?:计划[:：]|我打算|我将|我要|我会|接下来我?要?|下一步我?要?|然后我?要?|先|现在)\s*/;

export function stripIntentPrefix(text) {
  return norm(text).replace(INTENT_PREFIX_RE, "").trim();
}

/**
 * 从 assistant 的文本里取「预想道路」：一句意图级的话，不含实现细节。
 * 优先取最后一段里第一句像计划的话；取不到就用首句；都没有就空。
 */
export function intentFromAssistantText(text, limit = 200) {
  const body = norm(text);
  if (!body) return "";
  const sentences = body
    .split(/(?<=[。！？.!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 400);
  if (sentences.length === 0) return body.slice(0, limit);
  const hinted = sentences.filter((s) => INTENT_HINT_RE.test(s));
  const pick = hinted.length > 0 ? hinted[hinted.length - 1] : sentences[0];
  return stripIntentPrefix(pick).slice(0, limit);
}

/** 动作摘要：工具名 + 最关键参数（路径/命令/查询），≤240 字。 */
export function actionSummary(tool, args) {
  const name = String(tool ?? "?");
  const a = args && typeof args === "object" ? args : {};
  const parts = [];
  const push = (key) => {
    if (a[key] !== undefined && a[key] !== null && String(a[key]).length > 0) {
      parts.push(`${key}=${String(a[key]).replace(/\s+/g, " ")}`);
    }
  };
  // 不同工具的「关键参数」不同；按优先级取前两个，避免把整个 schema 抄进来
  const priority = ["file_path", "path", "command", "cmd", "pattern", "query", "url", "prompt", "description", "content"];
  for (const key of priority) {
    if (parts.length >= 2) break;
    push(key);
  }
  if (parts.length === 0) {
    const keys = Object.keys(a).slice(0, 2);
    for (const key of keys) push(key);
  }
  const body = parts.join(" ").slice(0, 200);
  return body ? `${name}(${body})` : name;
}

/**
 * 文件触碰记录：写类/命令类工具都算「可能改变世界」。
 * @returns string[] 相对或绝对路径
 */
export function touchedPaths(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  const out = [];
  for (const key of ["file_path", "path", "target", "destination"]) {
    if (typeof a[key] === "string" && a[key].length > 0) out.push(a[key]);
  }
  return out;
}

/** 从工具结果里找「被写入/修改的文件」提示（部分工具只回文本）。 */
export function writtenPathsFromResult(text) {
  const body = String(text ?? "");
  const out = [];
  const re = /(?:^|\n)\s*(?:[A-Z]\s+)?((?:[A-Za-z]:)?[^\s:*?"<>|]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|py|go|rs|java|css|html|sh))\b/g;
  let m;
  while ((m = re.exec(body)) !== null && out.length < 20) out.push(m[1]);
  return out;
}

/** 判断一个事件是不是「增量 fold 边界」可用的位置（粗略辅助）。 */
export function countNewlines(text) {
  return String(text ?? "").split("\n").length;
}
