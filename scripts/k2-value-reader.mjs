#!/usr/bin/env node
/**
 * k2-value-reader.mjs —— K-2「成功工具结果值」的**预注册**与 reader 夹具（AX-03）
 *
 * 任务书：docs/任务书-两条公理纠偏-2026-11-07.md · 任务卡 AX-03
 *   目标：在候选实现之前冻结 K-2 baseline/candidate 的问题、答案、判分、弃答与调用上限。
 *   约束：保留原 4 题；新增成功 write/read/API 值题；full/compact 配对；
 *         reader 请求不得含 gold/grader；禁止看到结果后改题；真实运行由 AX-12 执行。
 *
 * ## 为什么不能「先跑再定题」
 *
 * K-2 的历史结论是 **TASK_CONDITIONAL**（`evidence/k2-reader-expand-2026-11-07.json`：
 * 2 会话 / 4 题 / 8 次真实调用，baseline 4/4、everyStep 2/4）。再跑一次真实 reader 时，
 * 如果题面、金标准、判分器、弃答规则和调用上限没有在任何模型调用之前冻结，
 * 那么「这次没退化」既可能是实现变好，也可能是**换了更简单的题**。
 * 所以本文件是**先冻结、后运行**：题面与金标准写死在源码里，任何改动都会改变
 * `questionsSha256`，使既有结果无法复用（这正是我们想要的）。
 *
 * ## 臂映射（必须显式写清，不能靠名字猜）
 *
 * K-2 的两臂在任务书里叫 `full` / `compact`，在 K-2 研究里叫 `baseline` / `every-step`。
 * 二者**一一对应**，本文件把它写进 `ARM_MAPPING` 并要求在产出的 manifest 里原样带出：
 *
 *   full    = baseline   ：user/assistant 文本 + **原始** tool/result（当前生产行为，未清理）
 *   compact = every-step ：user/assistant 文本 + 生产 `renderFacts(graph)`；原始 tool/result 不进入上下文
 *
 *   ★ AX-20（K-2 复跑）：compact 臂固定 `renderFacts(graph, { factGuard: true })`。`factGuard !== true`
 *     时 `valueFactLines()` 一行都不产出（AX-08 ① 的零差异契约），AX-18 补的**字面 quote**
 *     （`— Created file` / `— "private": false`）就永远不渲染；而 K2-O1 问的正是
 *     「write 结果的 `<content>` 里写的是什么」—— 那个字面值只存在于 `edge.valueFacts[*].quote` 里。
 *     两臂的差异仍然**只有**「原始 tool/result 是否保留」，其余全部相同。
 *
 * 注意：compact 臂**必须在 AX-12 用当时的代码现场生成**，不得用冻结的 compact 文本冒充
 * 候选实现（任务书 AX-10 对 K-27 的同一条纪律）。本文件只冻结**题目、金标准、判分、
 * 弃答、调用上限与上下文构造规则**，不冻结上下文正文。
 *
 * ## 弃答（abstention）
 *
 * 上下文里没有明确记录该值时，唯一合法答案是**逐字 `UNKNOWN`**。不许用状态词
 * （untested / pending / archived / right-censored …）代替，也不许猜。
 * 判分器 `UNKNOWN` 只接受逐字 `UNKNOWN`；其它任何答案都是弃答违规。
 *
 * ## 泄漏契约（reader 请求只能有四个字段）
 *
 *   { id, arm, question, context }
 *
 * 金标准（answer / aliases）、判分器（grader）、来源坐标（sourceSeq / sessionHash）、
 * 题源标记（origin / kind）**一律不得**进入请求。`assertReaderPayload` 是唯一入口检查，
 * `leakPrecheck` 另外检查「题面本身有没有把答案写出来」。
 *
 * ## 无模型副作用
 *
 * 本模块**没有** fetch、没有模型客户端、没有默认 reader。真实 reader 只能由调用方
 * 经 `runReader(fixtures, reader)` **显式注入**；AX-12 负责注入 `deepseek-v4.1-flash-1017`。
 * 导入本模块不会发任何请求、不会写任何文件。
 *
 * ## 调用上限
 *
 * 10 题 × 2 臂 = **20 次逻辑调用** ≤ 上限 **24**。**不重试**：失败就是失败，
 * 原始输出与错误码保留在分母里（任务书「任一真实 reader 失败：保留失败原文和分母」）。
 *
 * ## 用法
 *
 *   node scripts/k2-value-reader.mjs                      # 打印预注册摘要（不写盘、不调模型）
 *   node scripts/k2-value-reader.mjs --check              # 结构 + 泄漏预检（纯函数）
 *   node scripts/k2-value-reader.mjs --write              # 写 tmp/axiom-2026-11-07/ax03/*.json
 *   node scripts/k2-value-reader.mjs --check --home <dir> # 额外用只读真实会话做覆盖预检
 *   node scripts/k2-value-reader.mjs --json               # 机读
 *
 * 退出码：0 全绿；1 校验/预检失败；2 参数错误。
 */
import nodeCrypto from "node:crypto";
import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { renderFacts } from "../src/rooms/ledger.mjs";
import { collectFoldValueFacts, plainText } from "../src/rooms/offline-fold.mjs";
import { extractValueFacts, readShapeForValueFacts, resultKindForValueFacts, toolNameFromAction, toolNameFromSource } from "../src/rooms/tool-value-facts.mjs";
import { classify } from "../src/rooms/verify.mjs";
import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { gradeAnswer } from "./lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 预注册文件 schema（prereg.json）。 */
export const SCHEMA = "k2-value-reader-prereg-v1";
/** 夹具文件 schema（fixtures.json）。 */
export const FIXTURE_SCHEMA = "k2-value-reader-fixtures-v1";
/** 真实 reader 结果 schema（AX-12 用）。 */
export const RESULTS_SCHEMA = "k2-value-reader-results-v1";

/** 两臂；顺序即调用顺序（每题的调用必须成对）。 */
export const ARMS = Object.freeze(["full", "compact"]);

/** 臂 → K-2 策略的一一映射。**名字不同不代表策略不同**，必须逐字带进 manifest。 */
export const ARM_MAPPING = Object.freeze({
  full: "baseline: user/assistant 文本 + 原始 tool/result（当前生产行为，未清理）",
  compact: "every-step: user/assistant 文本 + 生产 renderFacts(graph)；原始 tool/result 不进入上下文",
});

/** 调用上限：10 题 × 2 臂 = 20 次逻辑调用（上限 24）。 */
export const LIMITS = Object.freeze({
  questions: 10,
  callsPerQuestion: ARMS.length,
  plannedCalls: 10 * ARMS.length,
  maxCalls: 24,
  retries: 0,
});

/** 真实 reader 路由与解码参数（AX-12 必须原样使用）。 */
export const READER = Object.freeze({
  model: "deepseek-v4.1-flash-1017",
  endpoint: "http://127.0.0.1:3425/v1/chat/completions",
  temperature: 0,
  maxTokens: 1024,
  stream: false,
  timeoutMs: 120000,
});

/** 弃答规则：上下文没有明确记录时，唯一合法答案是逐字 UNKNOWN。 */
export const ABSTENTION = Object.freeze({
  answer: "UNKNOWN",
  rule: "上下文没有明确记录该值时，只输出逐字 UNKNOWN；不得用状态词（untested/pending/archived/right-censored）代替，不得猜测。",
  forbiddenSubstitutes: Object.freeze(["untested", "pending", "archived", "right-censored", "unknown", "N/A", "null"]),
});

/** 判分器集合：与 lme-task50 的冻结实现同源（不另写一套判分）。 */
export const GRADERS = Object.freeze(["exact", "set", "ordered", "UNKNOWN"]);

/** 冻结规则：写在文件里，改题必须先改这里并重新冻结。 */
export const FREEZE_RULES = Object.freeze([
  "题面、金标准、判分器、弃答规则与调用上限在任何真实 reader 调用之前冻结；AX-12 只能读取，不得修改。",
  "真实 reader 只跑一次：不重试、不换题、不删失败样本；UNKNOWN 与错误码原样进入分母。",
  "compact 臂必须由 AX-12 用当时的代码现场生成（renderFacts），不得用冻结的 compact 文本冒充。",
  "两臂除「原始 tool/result 是否保留」外，事件、模型路由、提示外壳、解码参数、超时全部相同。",
  "任何题目变更都会改变 questionsSha256，使既有结果作废；作废不是坏结果，改题掩盖才是。",
]);

/** reader 提示词：只要求「逐字短值 + 弃答」，不做推理、不给示例答案。 */
export const READER_PROMPT = Object.freeze(
  [
    "You answer a single question about what a conversation's tool results actually contained.",
    "Use only the supplied context.",
    "Output only the exact short value the question asks for, verbatim as written in the context.",
    "For a list answer, output the exact values comma-separated in the order they appear.",
    "Do not explain, do not quote, do not add code fences, do not paraphrase.",
    "If the context does not explicitly record the requested value, output exactly UNKNOWN.",
    "Never substitute a status word (untested, pending, archived, right-censored) for UNKNOWN.",
  ].join(" "),
);

/**
 * 冻结的 10 道题。
 *
 * `origin`：`original-4` = K-2 扩样证据里的原 4 题（保留题面主题）；
 *           `new-success-value` = 新增的成功 write/read/API 值题。
 * `sourceSeq`：该事实在**冻结会话日志**里所在的事件 seq（tool/result 的 seq）。
 * `hypothesis`：预注册假设（来自冻结的 K-2 扩样证据与字符串覆盖预检），不是金标准。
 *
 * ⚠ 修改任何一题都必须同步 `LIMITS.questions` 与 `questionsSha256`，并重新冻结。
 */
export const QUESTIONS = Object.freeze([
  {
    id: "K2-O1",
    origin: "original-4",
    kind: "write",
    sessionHash: "8ca0b786fa93ef9f",
    sourceSeq: 44,
    sourceTool: "write",
    question: "write 工具成功创建文件后，结果的 `<content>` 里写的是什么？",
    answer: "Created file",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-O2",
    origin: "original-4",
    kind: "read-failure",
    sessionHash: "8ca0b786fa93ef9f",
    sourceSeq: 24,
    sourceTool: "read",
    question: "read 工具读取一个不存在的 `AGENTS.md` 时，错误原文以哪个前缀开头？",
    answer: "Error: cannot read",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "safe",
  },
  {
    id: "K2-O3",
    origin: "original-4",
    kind: "api",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 35,
    sourceTool: "github",
    question: "GitHub API 返回的 magpie-Jet-Hub 仓库 JSON 中，id 与 private 的值分别是什么？",
    answer: Object.freeze(["1436032364", "false"]),
    grader: "set",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-O4",
    origin: "original-4",
    kind: "bash-failure",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 25,
    sourceTool: "bash",
    question: "第一次 git clone 失败时，无法连接的主机与端口是什么？",
    answer: "github.com:443",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "safe",
  },
  {
    id: "K2-N1",
    origin: "new-success-value",
    kind: "write",
    sessionHash: "8ca0b786fa93ef9f",
    sourceSeq: 46,
    sourceTool: "write",
    question: "write 工具写入 `group-d.md` 后，返回结果里的路径中，`agents-inserts` 的上一级目录名是什么？",
    answer: "dsh-latest-upgrade",
    grader: "exact",
    aliases: Object.freeze([]),
    // 该目录名同时出现在 ROOT_USER_REQUEST 里（任务书点名了目标路径）⇒ 按 K-2 规则属「安全」，
    // 用来证明「值型 / 用户约束可回证」的一侧，不是 K-2 的退化证据。write 结果只有
    // `Created file` 一个非路径值（已被 K2-O1 覆盖），所以 write 类新题在字符串级必然 safe。
    hypothesis: "safe",
  },
  {
    id: "K2-N2",
    origin: "new-success-value",
    kind: "read",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 171,
    sourceTool: "read",
    question: "read 回来的 `provider-registry.js` 中，`CodeArts (华为云)` 对应的 provider id 是什么？",
    answer: "codearts",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-N3",
    origin: "new-success-value",
    kind: "read",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 172,
    sourceTool: "read",
    question: "read 回来的 `plugin.mjs` 中，`DSH_PROVIDERS` 数组的前三个元素是什么？",
    answer: Object.freeze(["accio", "astudio", "autoclaw"]),
    grader: "ordered",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-N4",
    origin: "new-success-value",
    kind: "api",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 35,
    sourceTool: "github",
    question: "GitHub API 返回的 magpie-Jet-Hub 仓库 JSON 中，node_id 是什么？",
    answer: "R_kgDOVZgdbA",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-N5",
    origin: "new-success-value",
    kind: "api",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 129,
    sourceTool: "github",
    question: "GitHub API 返回的 `vendor/lib` 目录列表中，`accio-adapter.d.ts` 的 sha 是什么？",
    answer: "c6f9d7a186c54e87f79007f6e08626dcb8701e8c",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
  {
    id: "K2-N6",
    origin: "new-success-value",
    kind: "api",
    sessionHash: "6fc8fe5d1ef3c3da",
    sourceSeq: 129,
    sourceTool: "github",
    question: "GitHub API 返回的 `vendor/lib` 目录列表中，`accio-adapter.d.ts` 的 size 是多少字节？",
    answer: "23738",
    grader: "exact",
    aliases: Object.freeze([]),
    hypothesis: "degraded",
  },
]);

/** 原题数量（必须保留，不许被「新增题」挤掉）。 */
export const ORIGINAL_QUESTION_COUNT = 4;
/** 新增成功值题必须覆盖的工具类型。 */
export const REQUIRED_NEW_KINDS = Object.freeze(["write", "read", "api"]);

/** 合法 kind 集合（含原 4 题里的失败型两类）。 */
const KINDS = Object.freeze(["write", "read", "api", "read-failure", "bash-failure"]);
const ORIGINS = Object.freeze(["original-4", "new-success-value"]);
const SESSION_HASH = /^[0-9a-f]{16}$/;
/**
 * 金标准/判分器泄漏标记。
 *
 * 与 `scripts/lme-task50.mjs` 的冻结契约同源（那里只管 compact 臂），这里额外把
 * `sessionHash` / `sourceSeq` / `aliases` / `origin` 也纳入 —— 它们同样属于「台账」，
 * 一旦进入 reader 请求，模型就能反推哪一条是被问的事实。
 */
const GOLD_METADATA =
  /(?:["'](?:answer|aliases|evidenceSeqs|grader|applicability|sessionHash|sourceSeq|origin)["']\s*:|(?:^|\s)(?:answer|aliases|evidenceSeqs|grader|applicability|sessionHash|sourceSeq|origin)\s*[:=]|\bgold\b)/im;
/** reader 请求允许的字段（恰好四个）。 */
const READER_KEYS = Object.freeze(["arm", "context", "id", "question"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(text) {
  return nodeCrypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** 稳定序列化（键排序），用于冻结哈希；顺序变化不算改题，内容变化才算。 */
function canonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node)) {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, walk(node[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/** 题集冻结哈希：任何题面/金标准/判分器改动都会改变它。 */
export function questionsSha256(questions = QUESTIONS) {
  return sha256(
    canonicalJson(
      questions.map((item) => ({
        id: item.id,
        origin: item.origin,
        kind: item.kind,
        sessionHash: item.sessionHash,
        sourceSeq: item.sourceSeq,
        sourceTool: item.sourceTool,
        question: item.question,
        answer: item.answer,
        grader: item.grader,
        aliases: item.aliases,
      })),
    ),
  );
}

/** 答案归一化：只去首尾空白与**一层**包裹反引号/引号，不做语义改写。 */
export function normalizeAnswer(raw) {
  let text = String(raw ?? "").trim();
  if (text.startsWith("```") && text.endsWith("```") && text.length >= 6) text = text.slice(3, -3).trim();
  for (const [left, right] of [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
  ]) {
    if (text.startsWith(left) && text.endsWith(right) && text.length >= left.length + right.length) {
      text = text.slice(left.length, -right.length).trim();
      break;
    }
  }
  return text;
}

/** 答案的逐字片段列表（set/ordered 拆元素；exact 单值）。 */
export function answerPieces(fixture) {
  if (Array.isArray(fixture.answer)) return fixture.answer.map((entry) => String(entry));
  return [String(fixture.answer ?? "")];
}

/**
 * 校验冻结题集。**不把 errors 当 skip** —— 有任何错误就抛。
 * @param {any} input 题目数组或 `{questions: [...]}`
 */
export function validateQuestions(input) {
  const errors = [];
  const questions = Array.isArray(input) ? input : (input?.questions ?? []);
  if (!Array.isArray(questions)) {
    return { ok: false, errors: ["questions 必须是数组"], total: 0, byOrigin: {}, byKind: {} };
  }
  if (questions.length !== LIMITS.questions) errors.push(`题数必须是 ${LIMITS.questions}；实际 ${questions.length}`);
  const ids = new Set();
  const byOrigin = { "original-4": 0, "new-success-value": 0 };
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const [index, item] of questions.entries()) {
    const where = `questions[${index}](${item?.id ?? "?"})`;
    if (!isObject(item)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (typeof item.id !== "string" || item.id.trim() === "") errors.push(`${where} id 缺失`);
    else if (ids.has(item.id)) errors.push(`${where} id 重复：${item.id}`);
    else ids.add(item.id);
    if (!ORIGINS.includes(item.origin)) errors.push(`${where} origin 必须是 ${ORIGINS.join("|")}`);
    else byOrigin[item.origin] += 1;
    if (!KINDS.includes(item.kind)) errors.push(`${where} kind 必须是 ${KINDS.join("|")}`);
    else byKind[item.kind] += 1;
    if (typeof item.sessionHash !== "string" || !SESSION_HASH.test(item.sessionHash)) {
      errors.push(`${where} sessionHash 必须是 16 位小写十六进制`);
    }
    if (!Number.isInteger(item.sourceSeq) || item.sourceSeq <= 0) errors.push(`${where} sourceSeq 必须是正整数`);
    if (typeof item.sourceTool !== "string" || item.sourceTool.trim() === "") errors.push(`${where} sourceTool 缺失`);
    if (typeof item.question !== "string" || item.question.trim() === "") errors.push(`${where} question 缺失`);
    if (!GRADERS.includes(item.grader)) errors.push(`${where} grader 必须是 ${GRADERS.join("|")}`);
    // 答案必须「明确」：要么是非空字符串/非空数组，要么恰好是 UNKNOWN（且 grader=UNKNOWN）。
    const answer = item.answer;
    const isUnknown = answer === ABSTENTION.answer;
    if (Array.isArray(answer)) {
      if (answer.length === 0) errors.push(`${where} 答案数组不得为空（无法识别就写 UNKNOWN + grader=UNKNOWN）`);
      if (!answer.every((entry) => typeof entry === "string" && entry.trim() !== "")) errors.push(`${where} 答案数组只能含非空字符串`);
    } else if (typeof answer === "string") {
      if (answer.trim() === "") errors.push(`${where} 答案不得为空字符串`);
      if (isUnknown && item.grader !== "UNKNOWN") errors.push(`${where} 答案为 UNKNOWN 时 grader 必须是 UNKNOWN`);
    } else {
      errors.push(`${where} 答案必须是字符串或字符串数组`);
    }
    if (item.grader === "UNKNOWN" && !isUnknown) errors.push(`${where} grader=UNKNOWN 时答案必须逐字 UNKNOWN`);
    if (item.grader === "set" || item.grader === "ordered") {
      if (!Array.isArray(answer) || answer.length < 2) errors.push(`${where} ${item.grader} 判分要求答案数组至少 2 项`);
    }
    if (item.aliases !== undefined && !Array.isArray(item.aliases)) errors.push(`${where} aliases 必须是数组`);
    if (Array.isArray(item.aliases) && !item.aliases.every((entry) => typeof entry === "string")) {
      errors.push(`${where} aliases 只能含字符串`);
    }
    // 题面不得把答案直接写出来（否则测的是抄写，不是「值是否可见」）。
    if (typeof item.question === "string") {
      for (const piece of answerPieces(item)) {
        if (piece.trim() !== "" && !isUnknown && item.question.includes(piece)) {
          errors.push(`${where} 题面已包含答案片段「${piece}」—— 泄漏预检不通过`);
        }
      }
    }
  }
  if (byOrigin["original-4"] !== ORIGINAL_QUESTION_COUNT) {
    errors.push(`必须保留原 ${ORIGINAL_QUESTION_COUNT} 题；实际 ${byOrigin["original-4"]}`);
  }
  for (const kind of REQUIRED_NEW_KINDS) {
    if (byKind[kind] === 0) errors.push(`新增成功值题必须覆盖 ${kind}；实际 0 题`);
  }
  const plannedCalls = questions.length * LIMITS.callsPerQuestion;
  if (plannedCalls > LIMITS.maxCalls) errors.push(`计划调用 ${plannedCalls} 次超过上限 ${LIMITS.maxCalls}`);
  return { ok: errors.length === 0, errors, total: questions.length, byOrigin, byKind, plannedCalls };
}

/** 校验失败直接抛（调用方不得把 errors 当 skip）。 */
export function assertValidQuestions(input) {
  const validation = validateQuestions(input);
  if (!validation.ok) throw new Error(`invalid K-2 prereg questions:\n${validation.errors.join("\n")}`);
  return Array.isArray(input) ? input : input.questions;
}

/**
 * reader 可见契约：**恰好四个字段**，没有金标准、判分器或来源坐标。
 * @param {any} payload
 * @returns {true}
 */
export function assertReaderPayload(payload) {
  if (!isObject(payload)) throw new Error("reader payload 必须是对象");
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(READER_KEYS)) {
    throw new Error(`reader payload 字段泄漏或缺失：${keys.join(",")}（只允许 ${READER_KEYS.join(",")}）`);
  }
  if (!ARMS.includes(payload.arm)) throw new Error(`未知臂：${payload.arm}`);
  if (typeof payload.id !== "string" || payload.id.trim() === "") throw new Error("reader payload id 非法");
  if (typeof payload.question !== "string" || payload.question.trim() === "") throw new Error("reader payload question 非法");
  if (typeof payload.context !== "string" || payload.context.trim() === "") throw new Error("reader payload context 非法");
  // compact 臂是「生产 renderFacts 的输出」——它里面不许出现台账字段名。
  if (payload.arm === "compact" && GOLD_METADATA.test(payload.context)) {
    throw new Error("compact reader payload 含有金标准/台账元数据");
  }
  return true;
}

/** 构造 reader 请求（唯一入口；每次调用前必须再跑 `assertReaderPayload`）。 */
export function makeReaderPayload(fixture, arm, context) {
  if (!ARMS.includes(arm)) throw new Error(`未知臂：${arm}`);
  const payload = Object.freeze({ id: fixture.id, arm, question: fixture.question, context: String(context ?? "") });
  assertReaderPayload(payload);
  return payload;
}

/** reader 提示消息（system + user），不含任何金标准。 */
export function buildMessages(payload, { prompt = READER_PROMPT } = {}) {
  assertReaderPayload(payload);
  return Object.freeze([
    Object.freeze({ role: "system", content: prompt }),
    Object.freeze({ role: "user", content: `Context:\n${payload.context}\n\nQuestion: ${payload.question}\n\nAnswer:` }),
  ]);
}

/**
 * 泄漏预检。
 *
 * - `structure` 模式：只查请求字段与题面（不需要真实会话，测试与 CI 都跑这个）。
 * - `structure+context` 模式：额外用真实上下文再跑一次 compact 台账检查。
 *
 * @param {{fixtures?: any[], contexts?: Record<string, Record<string, string>>}} [options]
 */
export function leakPrecheck({ fixtures = QUESTIONS, contexts = null } = {}) {
  const errors = [];
  let checked = 0;
  for (const fixture of fixtures) {
    for (const arm of ARMS) {
      const context = contexts?.[fixture.id]?.[arm];
      if (contexts !== null && typeof context !== "string") {
        errors.push(`${fixture.id}/${arm} 缺少上下文，无法做上下文级泄漏预检`);
        continue;
      }
      let payload;
      try {
        payload = makeReaderPayload(fixture, arm, context ?? `[${arm} context placeholder]`);
      } catch (error) {
        errors.push(`${fixture.id}/${arm} payload 非法：${String(error?.message ?? error)}`);
        continue;
      }
      // ① 题面本身不得把答案写出来（否则测的是抄写，不是「值是否可见」）。
      for (const piece of answerPieces(fixture)) {
        if (piece.trim() === "" || piece === ABSTENTION.answer) continue;
        if (payload.question.includes(piece)) errors.push(`${fixture.id}/${arm} 题面含答案片段「${piece}」`);
      }
      // ② 只有 compact 臂的**上下文**查台账字段名：full 臂是原始会话正文（含答案本身），
      //    那是被测对象，不是泄漏 —— 这正是 K-27 冻结协议里「compact 才查 gold metadata」的同一条判据。
      //    注意只查 context，不查拼好的 prompt —— 提示词外壳本身就有 `Answer:` 这一行。
      if (arm === "compact" && GOLD_METADATA.test(payload.context)) {
        errors.push(`${fixture.id}/${arm} 上下文含金标准/台账元数据字段名`);
      }
      checked += 1;
    }
  }
  return {
    ok: errors.length === 0,
    mode: contexts === null ? "structure" : "structure+context",
    checked,
    errors,
  };
}

/* ─────────────────────────── 上下文构造（只读） ─────────────────────────── */

/** 事件 → 纯文本（与 tool-result-prune-ab 的生产同源口径一致，数组块不加分隔符）。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") out += block.text;
    else if (typeof block.arguments === "string") out += block.arguments;
  }
  return out;
}

function eventContent(event) {
  if (event?.type === "tool/result") return event.data?.message?.content;
  if (event?.type === "user/message" || event?.type === "assistant/message") {
    return event.data?.message?.content ?? event.data?.content;
  }
  return undefined;
}

/**
 * 两臂上下文（纯函数）。
 *
 *   full    = user/assistant 文本 + 原始 tool/result 文本
 *   compact = user/assistant 文本 + 生产 renderFacts(graph)
 *
 * @param {any[]} events 会话事件（已解析）
 * @param {string} facts 生产 `renderFacts(graph)` 的输出
 */
export function buildContexts(events, facts) {
  const fullParts = [];
  const retainedParts = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== "object") continue;
    const isTool = event.type === "tool/result";
    const isText = event.type === "user/message" || event.type === "assistant/message";
    if (!isTool && !isText) continue;
    const text = contentText(eventContent(event));
    fullParts.push(text);
    if (isText) retainedParts.push(text);
  }
  return { full: fullParts.join(""), compact: retainedParts.join("") + String(facts ?? "") };
}

/** 会话 id → 16 位哈希（与 K-2 冻结证据同一算法）。 */
export function sessionHashOf(sessionId) {
  return sha256(String(sessionId)).slice(0, 16);
}

/**
 * 按哈希在 `<home>/sessions/` 下定位冻结会话（只读）。
 * @returns {{sessionId:string, workspace:string, logFile:string}}
 */
export function resolveSession(home, sessionHash) {
  if (typeof home !== "string" || home.trim() === "") throw new Error("resolveSession 需要 home");
  const sessionsRoot = nodePath.join(home, "sessions");
  if (!nodeFs.existsSync(sessionsRoot)) throw new Error(`sessions 目录不存在：${sessionsRoot}`);
  for (const workspace of nodeFs.readdirSync(sessionsRoot).sort()) {
    const workspaceDir = nodePath.join(sessionsRoot, workspace);
    let entries;
    try {
      entries = nodeFs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (sessionHashOf(entry.name) !== sessionHash) continue;
      const logFile = nodePath.join(workspaceDir, entry.name, "session.v4.jsonl.zstd");
      if (!nodeFs.existsSync(logFile)) continue;
      return { sessionId: entry.name, workspace, logFile };
    }
  }
  throw new Error(`找不到哈希为 ${sessionHash} 的冻结会话（home=${sessionsRoot}）`);
}

/** 解析会话日志（多帧 zstd → 事件数组）。坏行计数，不静默吞。 */
export function parseEvents(buffer) {
  const decoded = decodeMultiFrameZstd(buffer);
  const events = [];
  let badEventLines = 0;
  for (const line of decoded.text.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badEventLines += 1;
    }
  }
  return { events, badEventLines, frames: decoded.frames, okFrames: decoded.okFrames };
}

/** 读取会话对应的棋谱（graph.json + delta 回放），delta 回放失败必须抛。 */
export function loadGraphFor(home, sessionId) {
  const graphFile = nodePath.join(home, "chess-context", "sessions", sessionId, "graph.json");
  if (!nodeFs.existsSync(graphFile)) throw new Error(`graph.json 不存在：${graphFile}`);
  const loaded = loadSessionGraph(graphFile);
  if (loaded.deltaError !== null && loaded.deltaError !== undefined) {
    throw new Error(`graph delta 回放失败（${sessionId}）：${loaded.deltaError}`);
  }
  return loaded.graph;
}

/**
 * 由**已构造好的图**生成两臂上下文（纯函数，只读）。
 *
 * ★ AX-20（K-2 复跑）：compact 臂**必须**开 `factGuard`，且默认就是开。
 *   关掉时 `valueFactLines()` 一行都不产出（AX-08 ① 的零差异契约）⇒ AX-18 补的**字面 quote**
 *   （`— Created file` / `— "private": false`）永远不渲染，K2-O1 这类「问结果原文里写了什么」的题
 *   必然答不出。`factGuard: true` 是 compact 臂定义的一部分，不是可调参数 —— 只有需要复现
 *   AX-12 基线时才会显式传 `false`。
 *
 * @param {object} graph 图（冻结图，或已把值事实派到副本上的图）
 * @param {any[]} events 会话事件（已解析）
 * @param {{factGuard?:boolean}} [options]
 */
export function buildContextsFromGraph(graph, events, { factGuard = true, maxValueFacts = 8 } = {}) {
  // 默认与生产 renderFacts 一致（8 条）。64 只允许由 tmp 实验运行器显式传入，
  // 不能写进冻结契约，否则 K-2 的 compact 臂不再等于生产输出。
  const facts = renderFacts(graph, { factGuard: factGuard === true, maxValueFacts });
  return { facts, contexts: buildContexts(events, facts), factGuard: factGuard === true };
}

/**
 * 用**当前代码**构造某一冻结会话的两臂上下文（只读）。
 * compact 臂的 facts 来自生产 `renderFacts(graph, { factGuard: true })`，不是冻结文本。
 */
export function buildSessionContexts(home, sessionHash, { factGuard = true } = {}) {
  const session = resolveSession(home, sessionHash);
  const graph = loadGraphFor(home, session.sessionId);
  const parsed = parseEvents(nodeFs.readFileSync(session.logFile));
  const { facts, contexts } = buildContextsFromGraph(graph, parsed.events, { factGuard });
  return { session, facts, contexts, events: parsed.events.length, badEventLines: parsed.badEventLines, frames: parsed.frames };
}

/* ─────────────────────── K-2 值事实派生（AX-21，纯函数、只读） ─────────────────────── */

/**
 * 把「当前代码会写进边上的值事实」派到**图的副本**上（不碰 live 图）。
 *
 * 为什么必须派生：K-2 两个冻结会话的 `graph.json` 早于 AX-04，`edge.valueFacts` **一条都没有**
 * （实测 0/17、0/33 条边），于是 `renderFacts(graph, {factGuard:true})` 与 `guard=false` 逐字相同
 * —— 候选等于基线，K-2 就永远测不出差异。这里用 **AX-02/AX-07 的同一个抽取器**
 * （`collectFoldValueFacts`，只读会话日志）重新抽一遍，挂到**证据结束 seq 恰好等于该事实
 * evidenceSeq 的那条边**上（AX-04 在 keeper 里正是「结算那一条边时写入」）。
 *
 * 四条不变量：
 *   ① **不写 live 图**：输入图被深拷贝后才挂；调用方传进来的对象一个字节都不变（测试钉住）。
 *   ② **唯一匹配才挂**：`evidence.end === evidenceSeq` 的边多于一条时，只有 `edge.action` 的
 *      工具名与 `fact.source`（`tool:<name>`）**唯一**对得上才挂 —— 宁可不答，不许挂错
 *      （K2-N4 的候选回答曾经是**另一条**响应的 `node_id`：那是把「正确弃答」变成「自信答错」）。
 *   ③ **多义只计数**：0 条命中记 `unmapped`（含「有边但工具名都对不上」），多条命中记 `multi`；
 *      两者都**不挂**，也不猜。
 *   ④ **可审计**：返回 `attached` 明细（边 id + 事实种类 + evidenceSeq），产物里能逐条对回源。
 *
 * ★ AX-22（2026-11-08）：抽取分**两趟**，因为两个新形状的开关**默认关闭**（线上 keeper 不传）：
 *   · 第 ① 趟 = `collectFoldValueFacts`（AX-02/AX-07 的同一个抽取器，**不传 options**）——
 *     旧形状（文件回执 / 路径 / JSON 对象短值）逐字不变；
 *   · 第 ② 趟 = `collectReadShapeValueFacts`（本文件）—— **只对读形**（`read` / `read_file` /
 *     GitHub REST 读形）打开 `allowReadContent` + `allowTopLevelArray`，补上 K-2 剩下的两条根因：
 *       read 正文行值（K2-N2 / K2-N3）、顶层 JSON 数组的标量（K2-N5 / K2-N6，`contents` API）。
 *   「这次结果算不算读」「算不算可信」两个判据仍然只来自 `src/rooms/tool-value-facts.mjs`
 *   （`readShapeForValueFacts` / `resultKindForValueFacts`）—— 本文件不写第二份。
 *   两趟按 `(kind, value, evidenceSeq)` 去重（同一份文本第 ② 趟会重复产出第 ① 趟的旧形状）。
 *
 * @param {object} graph 冻结图（只读）
 * @param {Array<object>} events 会话事件（只读）
 * @param {{rangeStart?:number, rangeEnd?:number, derive?:boolean}} [options]
 * @returns {{graph:object, derive:boolean, before:number, facts:number, attached:Array<{edge:string,kind:string,evidenceSeq:number}>, unmapped:number, multi:number}}
 */
export function deriveValueFacts(graph, events, { rangeStart = 1, rangeEnd = Number.MAX_SAFE_INTEGER, derive = true } = {}) {
  const copy = JSON.parse(JSON.stringify(graph ?? {}));
  const result = { derive: derive === true, before: countEdgeValueFacts(copy), facts: 0, attached: [], unmapped: 0, multi: 0 };
  if (derive !== true) return { graph: copy, ...result };
  // ★ 注意：`collectFoldValueFacts` 的默认参数（`rangeStart=null/rangeEnd=null`）会被
  //   `Number(null) === 0` 判成合法区间，于是「不传区间」= 一条都抽不到（AX-07 的默认路径坑）。
  //   这里**必须显式传区间**。
  const facts = mergeValueFacts(
    collectFoldValueFacts(events, { rangeStart, rangeEnd }),
    collectReadShapeValueFacts(events, { rangeStart, rangeEnd }),
  );
  result.facts = facts.length;

  const byEnd = new Map();
  for (const edge of Object.values(copy.edges ?? {})) {
    const end = Number(edge?.evidence?.end);
    if (!Number.isFinite(end)) continue;
    if (!byEnd.has(end)) byEnd.set(end, []);
    byEnd.get(end).push(edge);
  }

  for (const fact of facts) {
    const picked = pickFactEdge(byEnd.get(Number(fact.evidenceSeq)) ?? [], fact);
    if (picked.edge === null) {
      if (picked.reason === "multi") result.multi += 1;
      else result.unmapped += 1;
      continue;
    }
    const edge = picked.edge;
    edge.valueFacts = [...(Array.isArray(edge.valueFacts) ? edge.valueFacts : []), fact];
    result.attached.push({ edge: edge.id, kind: String(fact.kind), evidenceSeq: Number(fact.evidenceSeq) });
  }
  return { graph: copy, ...result };
}

/**
 * ★ AX-22：K-2 派生的**第二趟** —— 只对**读形**结果打开 `allowReadContent` / `allowTopLevelArray`。
 *
 * 为什么需要单独一趟：`collectFoldValueFacts`（`src/rooms/offline-fold.mjs`）不在本任务可写路径内，
 * 它调 `extractValueFacts` 时**不传 options**（线上 keeper 也不传）—— 两个新开关默认关闭是契约，
 * 所以「读形」这一趟只能在派生侧补。**判据本身不复制**：
 *   · 这次结果算不算读   → `readShapeForValueFacts`（room 的唯一来源）
 *   · 这次结果算不算可信 → `resultKindForValueFacts(classify(…))`（与 keeper / 离线路径同一对纯函数）
 *   · 真正的抽取         → `extractValueFacts(…, { allowReadContent:true, allowTopLevelArray:true })`
 * 本函数只做「事件 → (工具名, 实参, 文本, seq) 配对」这一件机械事（与 `collectFoldValueFacts`
 * 的配对口径逐字一致：`plainText(content)` + `source.callId` → `toolCallId` → `event.data.callId`
 * → 最近一次 `tool/call` 兜底），非读形结果**直接跳过**（连抽取都不调）。
 *
 * @param {Array<object>} events 会话事件（升序、只读）
 * @param {{rangeStart?:number, rangeEnd?:number}} [options] 与第一趟同一个区间（两趟必须同区间）
 * @returns {Array<{kind:string, value:string, quote:string, evidenceSeq:number, validAtSeq:number, source:string}>}
 */
function collectReadShapeValueFacts(events, { rangeStart = 1, rangeEnd = Number.MAX_SAFE_INTEGER } = {}) {
  const list = Array.isArray(events) ? events : [];
  const from = Number(rangeStart);
  const to = Number(rangeEnd);
  /** callId → {name, args}（与 `collectFoldValueFacts` 同一配对口径）。 */
  const calls = new Map();
  let lastCall = null;
  const out = [];
  for (const event of list) {
    if (event === null || typeof event !== "object") continue;
    const seq = Number(event.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    if (event.type === "tool/call") {
      let args = event.data?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* 实参不是 JSON 就原样留着：形状判定只读 method/body/confirm 三个键 */
        }
      }
      const call = { name: String(event.data?.name ?? "").trim(), args };
      const callId = event.data?.callId ?? event.data?.message?.toolCallId ?? event.data?.toolCallId ?? null;
      if (callId !== null && callId !== undefined) calls.set(String(callId), call);
      lastCall = call;
      continue;
    }
    if (event.type !== "tool/result") continue;
    if (!(seq >= from && seq <= to)) continue;
    const message = event.data?.message;
    const text = plainText(message?.content ?? event.data?.content);
    if (text.trim() === "") continue;
    const callId = message?.source?.callId ?? message?.toolCallId ?? event.data?.callId ?? null;
    const call = (callId === null || callId === undefined ? null : calls.get(String(callId))) ?? lastCall;
    const name = call?.name ?? "";
    // ★ 只有读形才开闸；非读形（write/bash/todo_write/…）连抽取都不调 —— 线上行为不可能的到这里。
    if (!readShapeForValueFacts(name, call?.args)) continue;
    const isError = message?.isError === true;
    const resultKind = resultKindForValueFacts(classify({ tool: name, text, isError }), name, call?.args);
    const facts = extractValueFacts(
      { tool: name, result: text, resultKind, isError, evidenceSeq: seq },
      { allowReadContent: true, allowTopLevelArray: true },
    );
    for (const fact of facts) {
      if (out.some((seen) => seen.kind === fact.kind && seen.value === fact.value && seen.evidenceSeq === fact.evidenceSeq)) continue;
      out.push(fact);
    }
  }
  return out;
}

/**
 * 两趟事实按 `(kind, value, evidenceSeq)` 合并（保持第一趟顺序）。
 *
 * 为什么要去重：第二趟对读形结果会**重复产出**第一趟的旧形状（`file_path`、JSON 对象的
 * `id`/`boolean`/`config`）—— **同一份文本、同一个 seq**，去重后事实集与「只跑第一趟」逐字段相同，
 * 只多出 read 正文行值与顶层数组标量这两类新事实。不去重会让 `facts` 计数翻倍、挂边重复。
 *
 * @param {...Array<object>} groups
 * @returns {Array<object>}
 */
function mergeValueFacts(...groups) {
  const out = [];
  for (const group of groups) {
    for (const fact of Array.isArray(group) ? group : []) {
      if (out.some((seen) => seen.kind === fact.kind && seen.value === fact.value && seen.evidenceSeq === fact.evidenceSeq)) continue;
      out.push(fact);
    }
  }
  return out;
}

/**
 * 一条值事实该挂哪条边（纯函数）。
 *
 * 判据顺序（AX-21）：
 *   ① 只有一条边 ⇒ 挂它（旧行为，逐字不变）；
 *   ② 多条边 ⇒ 用**工具名**消歧（`edge.action` 的工具名 vs `fact.source` 的 `tool:<name>`）；
 *   ③ 消歧后恰好一条 ⇒ 挂；0 条 ⇒ `unmapped`（有边但没有一条是这次调用的）；
 *      仍多于一条 ⇒ `multi`（**不挂**：多义时任何选择都是猜）。
 *
 * 「边没有可解析的工具名」（旧图 / 夹具里 `action` 缺失）**不构成排除证据** ——
 * 否则一张没有 `action` 的图会从「唯一命中」退化成「一条都不挂」，那是把旧语料误杀。
 *
 * @param {Array<object>} candidates `evidence.end === evidenceSeq` 的边
 * @param {{source?:string}} fact AX-02 的值事实
 * @returns {{edge: object|null, reason: "unique"|"tool"|"unmapped"|"multi"}}
 */
function pickFactEdge(candidates, fact) {
  if (candidates.length === 0) return { edge: null, reason: "unmapped" };
  if (candidates.length === 1) return { edge: candidates[0], reason: "unique" };
  const tool = toolNameFromSource(fact?.source);
  const matched = candidates.filter((edge) => {
    const name = toolNameFromAction(edge?.action);
    return name === "" || name === tool;
  });
  if (matched.length === 1) return { edge: matched[0], reason: "tool" };
  if (matched.length === 0) return { edge: null, reason: "unmapped" };
  return { edge: null, reason: "multi" };
}

/** 图里已经挂了多少条值事实（派生前后各算一次，产物里对照）。 */
function countEdgeValueFacts(graph) {
  let total = 0;
  for (const edge of Object.values(graph?.edges ?? {})) {
    if (Array.isArray(edge?.valueFacts)) total += edge.valueFacts.length;
  }
  return total;
}

/** 逐题覆盖预检：答案片段是否真的出现在某一臂的上下文里（字符串级，不是模型判分）。 */
export function coverageOf(fixture, contexts) {
  const norm = (text) => String(text ?? "").replace(/\s+/g, " ");
  const full = norm(contexts.full);
  const compact = norm(contexts.compact);
  const pieces = answerPieces(fixture).map(norm).filter((piece) => piece !== "");
  const present = (text) => pieces.every((piece) => text.includes(piece));
  return { full: present(full), compact: present(compact), pieces };
}

/**
 * 构造 AX-12 可直接运行的两臂夹具（**必须**用当时的代码现场生成 compact 臂）。
 * @returns {{schema:string, armMapping:object, sources:object[], fixtures:object[], coverage:object[]}}
 */
export function buildReaderFixtures({ home, questions = QUESTIONS } = {}) {
  const set = assertValidQuestions(questions);
  const byHash = new Map();
  for (const item of set) {
    if (!byHash.has(item.sessionHash)) byHash.set(item.sessionHash, buildSessionContexts(home, item.sessionHash));
  }
  const fixtures = [];
  const coverage = [];
  for (const item of set) {
    const built = byHash.get(item.sessionHash);
    const contexts = { full: built.contexts.full, compact: built.contexts.compact };
    const cover = coverageOf(item, contexts);
    if (!cover.full) throw new Error(`${item.id} 的答案不在 full 上下文里 —— 夹具无效（sourceSeq ${item.sourceSeq}）`);
    fixtures.push(Object.freeze({ ...item, contexts: Object.freeze(contexts) }));
    coverage.push({ id: item.id, kind: item.kind, ...cover, hypothesis: item.hypothesis, matched: cover.compact === (item.hypothesis === "safe") });
  }
  return {
    schema: FIXTURE_SCHEMA,
    armMapping: ARM_MAPPING,
    sources: [...byHash.entries()].map(([hash, built]) => ({
      sessionHash: hash,
      workspace: built.session.workspace,
      eventCount: built.events,
      badEventLines: built.badEventLines,
      frames: built.frames,
      factsChars: built.facts.length,
      fullChars: built.contexts.full.length,
      compactChars: built.contexts.compact.length,
    })),
    fixtures,
    coverage,
  };
}

/* ─────────────────────────── 真实 reader（由 AX-12 注入） ─────────────────────────── */

/**
 * 跑两臂并机械判分。**reader 必须显式注入**，本模块不提供默认实现。
 * @param {{fixtures:any[]}} run
 * @param {(payload:object)=>Promise<string>} reader
 */
export async function runReader({ fixtures }, reader) {
  if (typeof reader !== "function") throw new Error("runReader 需要显式注入 reader（本模块没有默认模型客户端）");
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error("runReader 需要非空 fixtures");
  const planned = fixtures.length * ARMS.length;
  if (planned > LIMITS.maxCalls) throw new Error(`计划调用 ${planned} 次超过上限 ${LIMITS.maxCalls}`);
  const results = [];
  for (const fixture of fixtures) {
    for (const arm of ARMS) {
      const payload = makeReaderPayload(fixture, arm, fixture.contexts?.[arm]);
      let raw = null;
      let error = null;
      try {
        raw = await reader(payload);
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      const answer = error === null ? normalizeAnswer(raw) : "";
      const grade = error === null
        ? gradeAnswer(fixture.answer, answer, fixture.grader, fixture.aliases ?? [])
        : { correct: false, code: "reader-error", message: error };
      results.push({
        id: fixture.id,
        kind: fixture.kind,
        arm,
        contextChars: payload.context.length,
        raw: raw === null ? null : String(raw),
        answer,
        grade,
        ...(error === null ? {} : { error }),
      });
    }
  }
  return { schema: RESULTS_SCHEMA, ...summarize(fixtures, results), results };
}

/** 汇总：两臂各自对错、退化清单、UNKNOWN 数与调用数（分母必须保留）。 */
export function summarize(fixtures, results) {
  const questions = fixtures.length;
  const calls = results.length;
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, { correct: 0, total: 0, unknown: 0, errors: 0 }]));
  for (const row of results) {
    const bucket = byArm[row.arm];
    bucket.total += 1;
    if (row.grade.correct) bucket.correct += 1;
    if (row.answer === ABSTENTION.answer) bucket.unknown += 1;
    if (row.error) bucket.errors += 1;
  }
  const degraded = [];
  for (const fixture of fixtures) {
    const full = results.find((row) => row.id === fixture.id && row.arm === "full");
    const compact = results.find((row) => row.id === fixture.id && row.arm === "compact");
    if (!full || !compact) continue;
    if (full.grade.correct && !compact.grade.correct) degraded.push({ id: fixture.id, kind: fixture.kind, reason: compact.grade.code });
  }
  const unknownIncrease = byArm.compact.unknown - byArm.full.unknown;
  const noRegression = degraded.length === 0;
  return {
    status: calls === 0 ? "NOT_RUN" : noRegression ? "PASS" : "REGRESSION",
    questions,
    calls,
    maxCalls: LIMITS.maxCalls,
    byArm,
    degraded,
    unknownIncrease,
    // K-2 判据：不许靠「多弃答」换「少错」—— compact 的 UNKNOWN 不得多于 full。
    abstentionClean: unknownIncrease <= 0,
    note: "字符串级汇总，不是模型判分；原始输出必须由 AX-12 私有落盘。",
  };
}

/* ─────────────────────────── 预注册产物 ─────────────────────────── */

/** 预注册主体：问题、答案、判分、弃答、调用上限、臂映射与冻结规则。 */
export function buildPrereg({ questions = QUESTIONS, frozenAtRev = null, frozenAt = null } = {}) {
  const set = assertValidQuestions(questions);
  return {
    schema: SCHEMA,
    taskId: "AX-03",
    objective: "在候选实现之前冻结 K-2 baseline/candidate 的问题、答案、判分、弃答与调用上限。",
    frozenAt: frozenAt ?? new Date().toISOString(),
    frozenAtRev,
    armMapping: ARM_MAPPING,
    limits: LIMITS,
    reader: READER,
    abstention: ABSTENTION,
    graders: GRADERS,
    freezeRules: FREEZE_RULES,
    originalQuestionCount: ORIGINAL_QUESTION_COUNT,
    questionIds: set.map((item) => item.id),
    questionsSha256: questionsSha256(set),
    realRun: { executor: "AX-12", editor: "forbidden", retries: 0 },
    privacy: {
      tier: "private-tmp",
      note: "fixtures.json 只含短值答案与来源坐标，不含完整会话正文；公开 evidence 只允许聚合数字。",
    },
    validation: validateQuestions(set),
  };
}

/** 夹具产物（不含上下文正文；上下文由 AX-12 用当时代码现场生成）。 */
export function buildFixturesDocument({ questions = QUESTIONS, prereg, coverage = null, sources = null, leak = null } = {}) {
  const set = assertValidQuestions(questions);
  const document = {
    schema: FIXTURE_SCHEMA,
    frozen: true,
    taskId: "AX-03",
    preregSha256: prereg ? sha256(canonicalJson(prereg)) : null,
    questionsSha256: questionsSha256(set),
    armMapping: ARM_MAPPING,
    callBudget: { questions: set.length, callsPerQuestion: LIMITS.callsPerQuestion, plannedCalls: set.length * LIMITS.callsPerQuestion, maxCalls: LIMITS.maxCalls, retries: 0 },
    contextBuilder:
      "buildReaderFixtures({home}) —— full=原始 tool/result + 文本；compact=文本 + 生产 renderFacts(graph)。AX-12 必须在运行时用当时代码生成，不得冻结 compact 正文。",
    questions: set.map((item) => ({ ...item })),
    sources,
    coverage,
    leakPrecheck: leak,
  };
  return document;
}

/* ─────────────────────────── CLI ─────────────────────────── */

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return "";
  return value;
}

function gitRev() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const asJson = argv.includes("--json");
  const write = argv.includes("--write");
  const check = argv.includes("--check") || write;
  const home = readFlag(argv, "--home") ?? process.env.DSH_HOME ?? null;
  const outDir = readFlag(argv, "--out") ?? nodePath.join(ROOT, "tmp", "axiom-2026-11-07", "ax03");

  const validation = validateQuestions(QUESTIONS);
  if (!validation.ok) {
    const payload = { status: "INVALID_PREREG", errors: validation.errors };
    if (asJson) stdout(JSON.stringify(payload, null, 2));
    else stderr(`✗ 预注册校验失败：\n${validation.errors.map((line) => `  - ${line}`).join("\n")}`);
    return 1;
  }

  const prereg = buildPrereg({ frozenAtRev: gitRev() });
  const structureLeak = leakPrecheck({ fixtures: QUESTIONS, contexts: null });

  let coverage = null;
  let sources = null;
  let contextLeak = null;
  if (home) {
    try {
      const built = buildReaderFixtures({ home, questions: QUESTIONS });
      coverage = built.coverage;
      sources = built.sources;
      const contexts = Object.fromEntries(built.fixtures.map((fixture) => [fixture.id, fixture.contexts]));
      contextLeak = leakPrecheck({ fixtures: QUESTIONS, contexts });
    } catch (error) {
      if (check) {
        const payload = { status: "CONTEXT_BUILD_FAILED", message: String(error?.message ?? error) };
        if (asJson) stdout(JSON.stringify(payload, null, 2));
        else stderr(`✗ 无法用只读真实会话构造上下文：${String(error?.message ?? error)}`);
        return 1;
      }
    }
  }

  const leak = contextLeak ?? structureLeak;
  const fixturesDocument = buildFixturesDocument({ questions: QUESTIONS, prereg, coverage, sources, leak });

  if (write) {
    nodeFs.mkdirSync(outDir, { recursive: true });
    const preregPath = nodePath.join(outDir, "prereg.json");
    const fixturesPath = nodePath.join(outDir, "fixtures.json");
    nodeFs.writeFileSync(preregPath, `${JSON.stringify(prereg, null, 2)}\n`, "utf8");
    nodeFs.writeFileSync(fixturesPath, `${JSON.stringify(fixturesDocument, null, 2)}\n`, "utf8");
    if (!asJson) {
      stdout(`wrote ${preregPath}`);
      stdout(`wrote ${fixturesPath}`);
    }
  }

  const summary = {
    status: leak.ok ? "FROZEN" : "LEAK_PRECHECK_FAILED",
    schema: SCHEMA,
    questions: QUESTIONS.length,
    plannedCalls: QUESTIONS.length * LIMITS.callsPerQuestion,
    maxCalls: LIMITS.maxCalls,
    questionsSha256: prereg.questionsSha256,
    leakPrecheck: leak,
    coverage: coverage ?? "NOT_RUN (no --home)",
    artifacts: write ? { prereg: nodePath.join(outDir, "prereg.json"), fixtures: nodePath.join(outDir, "fixtures.json") } : null,
  };
  if (asJson) stdout(JSON.stringify(summary, null, 2));
  else {
    stdout(`== K-2 预注册（AX-03）==`);
    stdout(`题数 ${summary.questions} · 计划调用 ${summary.plannedCalls}/${summary.maxCalls} · 冻结哈希 ${summary.questionsSha256.slice(0, 16)}…`);
    stdout(`泄漏预检：${leak.ok ? "通过" : "失败"}（${leak.mode}，检查 ${leak.checked} 个 payload）`);
    if (Array.isArray(coverage)) {
      for (const row of coverage) {
        stdout(`  · ${row.id} ${row.kind.padEnd(13)} full=${row.full ? "✓" : "✗"} compact=${row.compact ? "✓" : "✗"} 假设=${row.hypothesis}`);
      }
    }
    if (!leak.ok) for (const line of leak.errors.slice(0, 8)) stderr(`  - ${line}`);
  }
  if (!leak.ok) return 1;
  if (check && contextLeak !== null && !contextLeak.ok) return 1;
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(String(error?.stack ?? error));
      process.exitCode = 1;
    });
}
