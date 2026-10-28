/**
 * verifier.mjs —— 从工具结果里机械抽取「验证信号」
 *
 * 原则（对应用户与 qwen 的共识）：
 *   · 验证信号必须来自外部（exit code / 测试计数 / 报错原文 / diff 规模）
 *   · 判不出来的标 unverified，**绝不标 success** —— 污染棋谱比缺数据更糟
 *   · 失败必须留下可复述的原因（errorSnippet）
 *
 * ★ 运行期修正（v0.1.2，真实会话实测暴露）：
 *   旧版用一条 ERR_RE 通吃所有工具，导致只读工具的叙述文本（JSON 里的「失败」、
 *   记忆正文、代码注释里的 EACCES）全被判 failure —— 真实会话 55 条 failure 里 30+ 是误报。
 *
 *   现在的分层（顺序即优先级）：
 *     ① isError（宿主标记）                → failure（任何工具）
 *     ② 有 [exit code: N]：N≠0 → failure；N=0 → success（**最终裁决**）
 *     ②.b shell 但没有退出码                → unverified（**不猜**：输出可以是任何东西）
 *     ③ 非 shell：N passed / N failing      → success / failure
 *     ④ 非 shell：行首错误行                → failure
 *     ④.b 只读工具：行首硬错误（ENOENT…）    → failure（注释里的 EACCES 不算）
 *     ⑤ 写类成功（diff / 写入回执）          → success
 *     ⑥ 其余                              → unverified
 *
 * 纯函数，零依赖，可单测。
 */

const READ_ONLY_TOOLS = new Set([
  "read", "read_file", "glob", "grep", "ls", "list", "list_dir", "find",
  "web_search", "web_fetch", "read_page", "read_image", "library_search",
  "todo_write", "todo_read", "todo_list", "ask_user_question",
  "get_goal", "update_goal", "create_goal", "exit_plan_mode",
  "skill", "load_workspace_dependencies", "list_agents", "list_subagent_models",
  "job_list", "job_output", "team_task_list", "team_task_get",
]);

const WRITE_TOOLS = new Set([
  "write", "edit", "write_file", "edit_file", "apply_patch", "multi_edit",
  "str_replace", "create_file", "delete_file", "notebook_edit", "present",
]);

const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "pwsh", "powershell", "cmd", "run", "exec"]);

const QUERY_RE = /(search|read|list|get|find|query|fetch|lookup|recall|describe|status|probe|scan|inspect|analyze)/i;
const MUTATE_RE = /(write|edit|delete|create|update|put|post|insert|remove|apply|set|run|exec|send|push|drop|kill)/i;

export function toolClass(name) {
  const raw = String(name ?? "");
  const n = raw.toLowerCase();
  if (SHELL_TOOLS.has(n)) return "shell";
  if (WRITE_TOOLS.has(n)) return "write";
  if (READ_ONLY_TOOLS.has(n)) return "read";
  const isMcp = n.startsWith("mcp__") || n.includes("__") || n.startsWith("hindsight_") || n.startsWith("bili_");
  if (isMcp) return MUTATE_RE.test(n) && !QUERY_RE.test(n) ? "mcp-write" : "mcp-read";
  if (QUERY_RE.test(n) && !MUTATE_RE.test(n)) return "mcp-read";
  return "other";
}

/** 硬错误串（用于 errorSnippet 定位与无 exit 的非 shell 工具）。 */
const HARD_ERR_RE =
  /ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|No such file or directory|Permission denied|command not found|is not recognized as an internal or external command|Traceback \(most recent call last\)|Cannot find module|MODULE_NOT_FOUND|panic:/;

/** 行首错误行：`Error:` / `Traceback` / `FAILED:`。 */
const ERR_LINE_RE = /^\s*(?:bash: line \d+: )?(?:Error:|error:|ERROR:|Exception\b|Traceback\b|FAILED\b|FAIL:|fatal:)/;

/** 行首硬错误（只读工具也认——读一个不存在的文件）。 */
const HARD_LINE_RE = /^\s*(?:ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|No such file|Permission denied|Error:|error:|Traceback|Cannot find module|MODULE_NOT_FOUND)/;

const EXIT_RE = /\[exit code:\s*(-?\d+)\]/;
const TEST_PASS_RE = /(\d+)\s+(?:passed|passing|tests? passed|个?通过)|all tests passed|0 failing/i;
const TEST_FAIL_RE = /\b([1-9]\d*)\s+(?:failed|failing|个?失败|errors?)\b/i;
const DIFF_RE = /(\d+)\s*(?:insertions?\(\+\)|deletions?\(-\))/;

/** 取首个错误行 + 其后最多 2 行，截 400 字符。 */
export function errorSnippet(text, limit = 400) {
  const raw = String(text ?? "");
  if (!raw) return "";
  const lines = raw.split("\n");
  let start = lines.findIndex((line) => ERR_LINE_RE.test(line));
  if (start < 0) start = lines.findIndex((line) => HARD_ERR_RE.test(line));
  if (start < 0) start = 0;
  while (start < lines.length - 1 && /^\s*<anonymous_script>:\d+\s*$/.test(lines[start])) start += 1;
  let head = start;
  if (head > 0 && lines[head - 1].trim().length > 0 && lines[head - 1].length <= 120) head -= 1;
  return lines.slice(head, start + 3).join("\n").trim().slice(0, limit);
}

/**
 * 判定一次工具调用的结果。
 * @param {{tool:string, text:string, isError?:boolean}} input
 * @returns {{result:'success'|'failure'|'unverified', verify:{kind:string, summary:string}, errorSnippet:string}}
 */
export function classify({ tool, text, isError = false }) {
  const body = String(text ?? "");
  const cls = toolClass(tool);
  const readOnly = cls === "read" || cls === "mcp-read";

  if (isError) {
    return {
      result: "failure",
      verify: { kind: "host-error", summary: firstLine(body) || "host reported error" },
      errorSnippet: errorSnippet(body),
    };
  }

  // ★ 退出码只对 shell 有意义。真实踩坑：`read` 读一个包含 `[exit code: 1]` 字样的测试文件，
  //   旧逻辑会把那行字当成「这个 read 的退出码」→ 整条 read 被判 failure。
  //   read/write/mcp 工具的输出是**内容**，不是执行结果。
  if (cls === "shell") {
    // P1-7：退出码只看**末尾**。DSH 把 `[exit code: N]` 追加在结果最后；
    //   从全文第一处匹配会抓到输出正文里的字样（比如 sed 打印的测试文件里写着 `[exit code: 1]`），
    //   把一条 exit 0 的命令判成失败（真实日志里 e119/e189/e227 都是这么误报的）。
    const exit = EXIT_RE.exec(body.slice(-200));
    if (exit) {
      const code = Number(exit[1]);
      if (code !== 0) {
        return { result: "failure", verify: { kind: "exit", summary: `exit ${code}` }, errorSnippet: errorSnippet(body) };
      }
      return { result: "success", verify: { kind: "exit", summary: "exit 0" }, errorSnippet: "" };
    }
    return {
      result: "unverified",
      verify: { kind: "no-exit", summary: body ? `${body.length} chars, no exit code` : "empty" },
      errorSnippet: "",
    };
  }

  // P1-7：测试计数只对**非只读**工具生效。read/grep 读到 "all tests passed" 是在读文档，
  // 不是这个工具跑过测试（审查实测：classify({tool:"read",text:"all tests passed"}) → success）。
  if (!readOnly) {
    const pass = TEST_PASS_RE.exec(body);
    const failCount = TEST_FAIL_RE.exec(body);
    if (pass && !failCount) {
      return { result: "success", verify: { kind: "test", summary: pass[0].trim() }, errorSnippet: "" };
    }
    if (failCount) {
      return { result: "failure", verify: { kind: "test", summary: failCount[0].trim() }, errorSnippet: errorSnippet(body) };
    }
  }

  if (body.split("\n").some((line) => ERR_LINE_RE.test(line))) {
    return { result: "failure", verify: { kind: "error-line", summary: firstLine(body).slice(0, 160) }, errorSnippet: errorSnippet(body) };
  }

  if (readOnly && body.split("\n").some((line) => HARD_LINE_RE.test(line))) {
    return { result: "failure", verify: { kind: "hard-error", summary: firstLine(body).slice(0, 160) }, errorSnippet: errorSnippet(body) };
  }

  if (cls === "write") {
    const diff = DIFF_RE.exec(body);
    if (diff) return { result: "success", verify: { kind: "diff", summary: `${diff[1]} lines changed` }, errorSnippet: "" };
    return { result: "success", verify: { kind: "write", summary: firstLine(body).slice(0, 120) }, errorSnippet: "" };
  }

  return {
    result: "unverified",
    verify: { kind: readOnly ? "read" : "none", summary: body ? `${body.length} chars` : "empty" },
    errorSnippet: "",
  };
}

function firstLine(text) {
  const line = String(text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
}

export const _internal = { READ_ONLY_TOOLS, WRITE_TOOLS, SHELL_TOOLS, firstLine, HARD_ERR_RE, ERR_LINE_RE, HARD_LINE_RE };
