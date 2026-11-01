#!/usr/bin/env node
/**
 * boundary-audit.mjs —— 「压缩不得越权」的机器审计（2026-11-01）
 *
 * 为什么要有它：`docs/压缩的职责边界.md` 是这个项目的成文法，但此前只有**人工**审计
 * （§3 的逐项表格）。人工审计会漏，尤其在连续多轮快速改动之后。这个脚本把最容易越界的两类
 * 东西变成每次可跑的检查：
 *
 *   ① **行为指导**：压缩产物是给主 agent 的上下文，不是给它下指令的地方。
 *      「下一步：…」「不要重试…」「you should…」「continue or abandon」这类字样一旦出现在
 *      **模型可见的字符串字面量**里，就是替 AGENTS/persona 干活（= 越权）。
 *   ② **工具治理**：`permission: allow|ask|deny` / approval / sandbox 这类开关属于宿主与工具层，
 *      压缩插件碰了就是越界。
 *
 * 实现要点：只扫**字符串字面量**，且**先剥注释** —— 我们的注释里大量引用「旧版曾写：不要重试…」
 * 用于说明为什么删掉它；把注释算进去会天天假红（第 2 轮就是这么被噪声坑过一次）。
 *
 * 用法：
 *   node scripts/boundary-audit.mjs            # 扫 src/ 全部 .mjs（跳过 . 开头的临时副本）
 *   node scripts/boundary-audit.mjs --json
 * 退出码：发现任何 error 级问题 ⇒ 1。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 审计规则。`re` 只作用于**字符串字面量内部**。 */
export const RULES = [
  {
    id: "behavior-guidance",
    level: "error",
    why: "压缩产物不得包含行动指导（属于 AGENTS / persona）",
    re: /(下一步\s*[:：]|不要重试|建议你|建议先|务必先|请先执行|you should|you must|you may\b|continue or abandon|tell the user|the next action)/i,
  },
  {
    // ★ C45：英文行动建议（"retry when…" / "take it"）与中文同类 —— 旧审计只认中文与 you should/must，
    //   结果热清单的标记图例里长期带着 "retry when it changes / take it" 没被抓到。
    id: "retry-advice",
    level: "error",
    why: "压缩产物不得给出「何时再试 / 该走哪条路」的行动建议（属于 AGENTS / persona）",
    re: /(retry when|retry only|retry it|retry whenever|take it|or create it|should retry)/i,
  },
  {
    id: "tool-governance",
    level: "error",
    why: "工具契约 / 权限治理属于宿主与工具层，压缩不得自建",
    re: /(permission\s*:\s*(?:allow|ask|deny)|approval\s*:|sandbox_permissions|tool_schema\s*:)/i,
  },
];

/**
 * 允许清单：同一条线索出现在**不该算越界**的位置时在这里登记，必须写清为什么。
 * 目前只有一类：`facts-prompt.mjs` 是**喂给摘要模型的指令模板**（不注入主 agent）——
 * 它约束的是「怎么压缩、哪些不许丢」，不是「agent 该做什么」，属于压缩执行的一部分。
 */
export const ALLOW = [
  {
    file: "src/rooms/facts-prompt.mjs",
    rule: "behavior-guidance",
    why: "只喂摘要模型的指令模板（不注入主 agent）：约束的是压缩行为，不是 agent 行为",
  },
];

/** 这条 finding 是否被允许清单豁免。 */
export function isAllowed(finding, allow = ALLOW) {
  return allow.some((entry) => entry.file === finding.file && entry.rule === finding.rule);
}

/**
 * 剥掉注释（保留换行，便于行号对齐）：先块注释，再行注释。
 * 注意：不做完整的 JS 词法分析 —— 对「我们自己的源码」够用；误剥风险由测试钉住。
 */
export function stripComments(source) {
  const withoutBlock = String(source ?? "").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlock.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** 提取字符串字面量（`…`、"…"、'…'）。模板里的 `${}` 不展开，按原文匹配即可。 */
export function stringLiterals(source) {
  const out = [];
  const re = /`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(String(source ?? ""))) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    if (text !== "") out.push({ text, index: m.index });
  }
  return out;
}

/** 行号（1-based）：由字符下标换算。 */
function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * 扫一段源码，返回 findings（纯函数，便于单测）。
 * @param {string} source
 * @param {{file?: string}} [opts]
 * @returns {Array<{rule:string, level:string, why:string, file:string, line:number, text:string}>}
 */
export function scanSource(source, { file = "<inline>" } = {}) {
  const stripped = stripComments(source);
  const findings = [];
  for (const literal of stringLiterals(stripped)) {
    for (const rule of RULES) {
      if (!rule.re.test(literal.text)) continue;
      findings.push({
        rule: rule.id,
        level: rule.level,
        why: rule.why,
        file,
        line: lineOf(stripped, literal.index),
        text: literal.text.length > 120 ? `${literal.text.slice(0, 120)}…` : literal.text,
      });
    }
  }
  return findings;
}

/** 递归列出目录下的 .mjs 文件（跳过以 `.` 开头的文件/目录 —— 那些是测试临时副本）。 */
export function listSources(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of nodeFs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = nodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 审计整个仓库（src/），返回 {findings, scanned}。 */
export function auditRepo({ root = REPO } = {}) {
  const srcDir = nodePath.join(root, "src");
  const files = listSources(srcDir);
  const findings = [];
  for (const file of files) {
    const rel = nodePath.relative(root, file).replace(/\\/g, "/");
    findings.push(...scanSource(nodeFs.readFileSync(file, "utf8"), { file: rel }));
  }
  const effective = findings.filter((f) => !isAllowed(f));
  return { findings: effective, scanned: files.length, allowed: findings.length - effective.length };
}

function main() {
  const asJson = process.argv.includes("--json");
  const { findings, scanned, allowed } = auditRepo();
  const errors = findings.filter((f) => f.level === "error").length;
  if (asJson) {
    console.log(JSON.stringify({ scanned, errors, findings }, null, 1));
  } else {
    console.log(`== 压缩边界审计（扫 ${scanned} 个 src/**/*.mjs${allowed > 0 ? ` · 豁免 ${allowed} 条（见脚本 ALLOW）` : ""}）==`);
    if (findings.length === 0) console.log("  ✓ 没有发现越界线索（行为指导 / 工具治理）");
    for (const f of findings) console.log(`  ✗ [${f.rule}] ${f.file}:${f.line} —— ${f.why}\n      ${f.text}`);
    console.log(`\n${errors === 0 ? "✅" : "❌"} 越界线索 ${errors} 条`);
  }
  process.exitCode = errors > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
