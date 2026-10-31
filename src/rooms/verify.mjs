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
 *     ①.b local-mutate（本地状态写入类）    → unverified + kind:"none"，**不带 weak**
 *     ② 末条非空行**精确**是 [exit code: N]：N≠0 → failure；N=0 → success（**最终裁决**）
 *     ②.b shell 但没有精确退出码             → unverified（**不猜**：输出可以是任何东西）
 *     ③ 非 shell：N passed / N failing      → success / failure
 *     ④ 非 shell：行首错误行                → failure
 *     ④.b 只读工具：行首硬错误（ENOENT…）    → failure（注释里的 EACCES 不算）
 *     ⑤ 写类成功（diff / 写入回执）          → success
 *     ⑥ 其余                              → unverified
 *
 * ★ S2a（2026-10-30）：⑥ 里「只读类工具 + 输出非空 + 无任何失败信号」的那部分，
 *   额外打一个 `weak: "read"` 标记（**result 仍是 unverified**）。
 *   它只用于热清单的 WORKING 路径（ledger），不进 success / failureEdges / facts / tewari。
 *   为什么改这里而不是新加判据：`verify.kind === "read"` 就是 classify 自己给出的
 *   「只读工具、没抓到外部验证信号」的判定（toolClass 的显式表 + MCP query/mutate 词形），
 *   旧图里已经落盘了这个字段 —— 复用它，就不必在渲染阶段重新猜工具名。
 *
 * ★ OPT-VERIFY（task-124）：上面那条「已知局限」已修 —— `todo_write` / `update_goal` /
 *   `create_goal` / `hindsight_ingest_document` / `team_task_*` / `send_message` / `schedule_*` /
 *   `job_kill` / `spawn_teammate` / `subagent` 这些**会改本地状态**的工具，已从只读表拆到
 *   `LOCAL_MUTATE_TOOLS`（toolClass → `local-mutate`），classify 给
 *   `result:"unverified"` + `kind:"none"` 且**不带 weak** ⇒ 不再进 WORKING 路径。
 *   `weak:"read"` 现在只属于真正只读的工具（read / grep / web_fetch / list_* 等）。
 *   兼容：旧图里这些工具已落盘 `kind:"read"` + `N chars`，`weakKindOf` 仍按旧形态识别它们
 *   （历史数据不改写；新产生的边不再这样标）。
 *
 * 纯函数，零依赖，可单测。
 */

const READ_ONLY_TOOLS = new Set([
  "read", "read_file", "glob", "grep", "ls", "list", "list_dir", "find",
  "web_search", "web_fetch", "read_page", "read_image", "library_search",
  "todo_read", "todo_list", "ask_user_question",
  "get_goal",
  "skill", "load_workspace_dependencies", "list_agents", "list_subagent_models",
  "job_list", "job_output", "team_task_list", "team_task_get",
]);

/**
 * ★ OPT-VERIFY（task-124）：**本地状态写入类**工具 —— 既不是只读，也不是仓库写入。
 *
 * 它们不产生外部验证信号（没有 exit code / 测试计数 / diff），但**确实改了本地状态**
 * （todo 列表、goal、记忆库、任务板、消息、定时任务、子 agent、job）。
 * 旧版把它们混在 `READ_ONLY_TOOLS` 里 ⇒ 走 ⑥ 兜底分支拿到 `weak:"read"`，
 * 于是热清单的 WORKING 路径会把「写了一条 todo」当成「读过一眼的弱成功」——
 * 25 个最新会话 641 条只读结果里 48 条（7.5%）正是这种形态（S2a 注释里已记为已知局限）。
 *
 * 现在的语义：`toolClass` 返回 **`local-mutate`**，`classify` 给
 * `result:"unverified"` + `kind:"none"`，**不带任何 weak** —— 不进 WORKING 路径，
 * 也不进 success / failureEdges / facts / tewari。
 *
 * ⚠ 与 `WRITE_TOOLS` 的区别：`WRITE_TOOLS` 是**仓库写入**（write / edit / present …），
 * 它们的回执本身算成功信号（`kind:"write"` / `kind:"diff"`），**本刀一个字不改**。
 */
const LOCAL_MUTATE_TOOLS = new Set([
  "todo_write", "update_goal", "create_goal", "exit_plan_mode",
  "hindsight_ingest_document", "hindsight_capture_initiative",
  "team_task_create", "team_task_update", "team_task_delete",
  "send_message", "spawn_teammate", "subagent", "subagent_fork", "subagent_role",
  "schedule_create", "schedule_update", "schedule_delete",
  "job_kill", "job_start",
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
  // ★ 顺序要紧：local-mutate 必须排在 read 之前，否则这些工具又会被当只读。
  if (LOCAL_MUTATE_TOOLS.has(n)) return "local-mutate";
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

/**
 * ★ OPT-VERIFY（task-124）：退出码 marker 必须**独占最后一条非空行**（允许行内前后空白）。
 *
 * 旧写法 `EXIT_RE.exec(body.slice(-200))` 双向都有错：
 *   ① 只搜末尾 200 字符 ⇒ 标记之后还有别的输出时，**真退出码直接丢失**（判成 no-exit）；
 *   ② 只要落在末尾 200 字符内就命中 ⇒ `cat` 出来的源码里写着 `const text = "[exit code: 1]" + …`
 *      这种**正文子串**会被误当成命令退出码（独立复核活证据 e8）。
 * 现在的判据只有一条：末条非空行整行等于 `[exit code: N]`；否则一律 no-exit（**不猜**）。
 */
const EXIT_LINE_RE = /^\s*\[exit code:\s*(-?\d+)\]\s*$/;

/** 末条非空行的精确退出码；不是精确 marker ⇒ `null`。 */
export function lastLineExitCode(body) {
  const lines = String(body ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length === 0) continue;
    const m = EXIT_LINE_RE.exec(lines[i]);
    return m === null ? null : Number(m[1]);
  }
  return null;
}

const TEST_PASS_RE = /(\d+)\s+(?:passed|passing|tests? passed|个?通过)|all tests passed|0 failing/i;
const TEST_FAIL_RE = /\b([1-9]\d*)\s+(?:failed|failing|个?失败|errors?)\b/i;
const DIFF_RE = /(\d+)\s*(?:insertions?\(\+\)|deletions?\(-\))/;

/* ───────────────────── S2b：no-exit 的 N1 否决规则表 ───────────────────── */

/**
 * ★ S2b（2026-10-30）：shell 无退出码时，「默认算弱成功」前的 8 条否决特征。
 *
 * 背景（WS-S2B 采样报告，`tmp/dsh-gokifu-compact/ws-s2b/REPORT.md`）：
 *   · 本宿主**只在非零时**追加 `[exit code: N]`（32 会话实测：`[exit code: 0]` 0 次，
 *     `[exit code: N≠0]` 153 次，无标记 3225 次）⇒ no-exit 的先验极强地指向 exit 0；
 *   · 但「无标记」≠「一定成功」：管道会把前段退出码换成 tail 的、node/python 崩溃也可能丢标记。
 *     全收 no-exit 做 weak 的实测误报率 2.94%（95% CI 2.25–4.03%，外推 9762 条约 287 条假进展）。
 *   · 加下面 8 条否决特征后残余 0.49%（约 48 条），只损失 2.66% 的弱边。
 *
 * 为什么是「否决表」而不是「白名单」：no-exit 的底率是 95.5% 真成功，白名单会把大量
 * 正常命令挡在外面；否决表只挡**有明确失败证据**的那一小撮。
 *
 * ★ 纪律：判据只在这一处。`classify()` 的 shell 分支与测试都从这张表读，禁止在别处再写一份
 *   正则 —— 散落的规则改一处漏一处，是 S2b 报告里点名要避免的。
 * ★ 只影响 `weak` 标记；`result` 永远保持 `unverified`（弱成功不能进 success/failure）。
 */
export const SHELL_WEAK_VETO_RULES = Object.freeze([
  {
    id: "SELFEXIT",
    why: "末行自报非零退出（`exit=1` / `EXIT:1` / `exit code: 1`，允许行内前缀如 `diff exit=1`）",
    // ★ 按真实语料校正：实测最后一行是 `diff exit=1`（不是裸的 exit=1）⇒ 允许行内前缀；
    //   但只认**最后一行**，避免把正文中间提到的 exit=1 当命令退出码。
    test: (text) => /(?:^|\s)(?:exit(?:\s*code)?|EXIT)\s*[:=]\s*[1-9]\d*\s*$/i.test(lastNonEmptyLine(text)),
  },
  {
    id: "NODECRASH",
    why: "末行是 `Node.js vX.Y.Z`（node 未捕获异常的固定尾巴）",
    test: (text) => /^Node\.js v\d+\.\d+\.\d+$/.test(lastNonEmptyLine(text)),
  },
  {
    id: "STACKTAIL",
    why: "尾部 node 栈迹（`    at file:///…` / `at Object.` / `at Module.` / `at node:` / `at process.`）",
    test: (text) => /^[^\S\n]+at (?:file:\/\/|Object\.|Module\.|node:|process\.)/m.test(text),
  },
  {
    id: "NOTFOUND",
    why: "命令/文件不存在（command not found / No such file or directory / cannot stat / failed to run command）",
    test: (text) => /(?:command not found|No such file or directory|cannot stat|failed to run command)/.test(text),
  },
  {
    id: "ERRTYPE",
    why: "行首是解释器/断言错误类型（SyntaxError / AssertionError / TypeError / ReferenceError …）",
    test: (text) =>
      /^[^\S\n]*(?:SyntaxError|AssertionError|UnicodeEncodeError|UnicodeDecodeError|TypeError|ReferenceError|RangeError|ValueError|KeyError|IndexError|NameError|ImportError|ModuleNotFoundError|ZeroDivisionError|AttributeError)\b/m.test(
        text,
      ),
  },
  {
    id: "TESTFAIL",
    why: "测试框架自报失败（`FAILED (failures=N)` / `FAILED (errors=N)`）",
    test: (text) => /^[^\S\n]*FAILED \([^\S\n]*(?:failures|errors)=\d+\)/m.test(text),
  },
  {
    id: "NPMERR",
    why: "npm 错误行（`npm error …`）",
    test: (text) => /^npm error /m.test(text),
  },
  {
    id: "PYTRACE",
    why: "Python traceback 头（`Traceback (most recent call last):`）",
    test: (text) => /^Traceback \(most recent call last\):/m.test(text),
  },
]);

/** 最后一行非空（去掉 CRLF 与首尾空白）。真实工具输出是 CRLF（Git Bash / pwsh），必须归一。 */
function lastNonEmptyLine(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/**
 * 返回命中的否决规则 id 列表（空 = 无失败证据，可标 weak:"shell"）。
 * 纯函数，测试直接断言每条规则的正反例。
 * ★ 先归一 CRLF：真实工具结果（Git Bash / pwsh）用 `\r\n`，不归一的话所有 `$` 锚点都会漏。
 */
export function shellWeakVetoHits(text) {
  const body = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return SHELL_WEAK_VETO_RULES.filter((rule) => rule.test(body)).map((rule) => rule.id);
}

/** 常见工具的「结论行」（shell 输出里最像错误的一行）。 */
const TOOL_ERR_RE = /^\s*(?:sed|awk|grep|cp|mv|rm|mkdir|tar|git|npm|node|python|python3|bash|sh|curl|docker|make|tsc)\s*:\s*.*(?:error|unknown command|invalid option|unrecognized option|no such|cannot|not found|denied|failed)/i;

/**
 * 取「最像结论」的那几行，截 400 字符。
 *
 * ★ 2026-10-29 实机修正（模型消费者视角）：旧版从**第一个**匹配行往下取 3 行，于是
 *   · Python traceback 取到的是 `[stderr]` + `Traceback (most recent call last):` + 第一帧 ——
 *     真正的结论（最后一行 `TypeError: ...`）一个字都没有；实测本会话 e373 就是这样。
 *   · 带 `[stderr]` 流标记的结果，第一行永远是标记本身（0 信息）。
 *   现在的取法：① traceback ⇒ 取**最后一行顶格**（异常结论）；② 否则优先 `XxxError:` 行；
 *   ③ 再退到硬错误串 / 常见工具错误行；④ 都没有才退到前 3 行。全程跳过 `[stderr]` / `[stdout]` 标记行。
 */
export function errorSnippet(text, limit = 400) {
  const raw = String(text ?? "");
  if (!raw) return "";
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const isMarker = (line) => /^\s*\[(?:stderr|stdout)\]\s*$/i.test(line);
  const clean = (picked) => picked.filter((line) => !isMarker(line)).join("\n").trim().slice(0, limit);

  // ① traceback：帧在中间，结论是最后那条 `XxxError:`（没有就取最后一个顶格行）
  const tb = lines.findIndex((line) => /Traceback \(most recent call last\)/.test(line));
  if (tb >= 0) {
    const after = lines
      .slice(tb + 1)
      .filter((line) => line.trim().length > 0 && !isMarker(line) && !/^\s*\[exit code:\s*-?\d+\]\s*$/.test(line));
    const errLine = [...after].reverse().find((line) => /(?:^|[\s.])(?:[A-Za-z_$][\w$]*(?:Error|Exception))\b/.test(line));
    const conclusion = errLine ?? [...after].reverse().find((line) => !/^\s/.test(line));
    return clean(conclusion === undefined ? after.slice(-2) : [conclusion]);
  }

  // ②③ 结论行（顺序有讲究：行首锚定的优先，避免被注释/正文里出现的 EACCES 之类抢先）
  for (const re of [
    /(?:^|[\s:（(])(?:[A-Za-z_$][\w$]*(?:Error|Exception))\s*:/,
    ERR_LINE_RE,
    HARD_LINE_RE,
    TOOL_ERR_RE,
  ]) {
    const idx = lines.findIndex((line) => !isMarker(line) && re.test(line));
    if (idx < 0) continue;
    const from = /^\s*<anonymous_script>:\d+\s*$/.test(lines[idx]) ? idx + 1 : idx;
    return clean(lines.slice(from, from + 3));
  }

  // ④ 兜底
  return clean(lines.slice(0, 3));
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
  const localMutate = cls === "local-mutate";

  if (isError) {
    return {
      result: "failure",
      verify: { kind: "host-error", summary: firstLine(body) || "host reported error" },
      errorSnippet: errorSnippet(body),
    };
  }

  // ★ OPT-VERIFY（task-124）：本地状态写入类工具（todo_write / update_goal / send_message /
  //   team_task_update / hindsight_ingest_document …）没有外部验证信号，也**不是**「读了一眼」。
  //   ⇒ unverified + kind:"none" + **不带 weak**：不许进 WORKING 路径，更不许当进展证据。
  //   放在 isError 之后、shell 之前：宿主报错仍然是 failure（isError 优先级最高，不变）。
  if (localMutate) {
    return {
      result: "unverified",
      verify: { kind: "none", summary: body ? `${body.length} chars` : "empty" },
      errorSnippet: "",
    };
  }

  // ★ 退出码只对 shell 有意义。真实踩坑：`read` 读一个包含 `[exit code: 1]` 字样的测试文件，
  //   旧逻辑会把那行字当成「这个 read 的退出码」→ 整条 read 被判 failure。
  //   read/write/mcp 工具的输出是**内容**，不是执行结果。
  if (cls === "shell") {
    // P1-7：退出码只看**末尾**。DSH 把 `[exit code: N]` 追加在结果最后；
    // P1-7 → OPT-VERIFY（task-124）：判据从「末尾 200 字符里搜到 marker」改成
    //   **末条非空行整行等于 `[exit code: N]`**。旧写法两头都错：标记后面还有输出时真退出码丢失；
    //   正文里恰好出现 `[exit code: 1]` 子串时误判失败（复核活证据 e8）。
    //   不是精确 marker ⇒ 走下面的 no-exit（**不猜**）。
    const code = lastLineExitCode(body);
    if (code !== null) {
      if (code !== 0) {
        return { result: "failure", verify: { kind: "exit", summary: `exit ${code}` }, errorSnippet: errorSnippet(body) };
      }
      return { result: "success", verify: { kind: "exit", summary: "exit 0" }, errorSnippet: "" };
    }
    return {
      result: "unverified",
      verify: { kind: "no-exit", summary: body ? `${body.length} chars, no exit code` : "empty" },
      errorSnippet: "",
      // ★ S2b（2026-10-30）：no-exit 默认打 `weak:"shell"` —— 本宿主只在非零时追加退出码标记，
      //   无标记是「宿主没报错」的强信号（32 会话实测底率 95.5%）。但命中 N1 任一失败特征就**不给**：
      //   宁可少标一条弱边，也不要把真失败当成进展（全收实测误报 2.94%）。
      //   ⚠ 空输出也不给：没有任何内容可判断，标了等于猜。
      //   ⚠ `result` 一个字不动，仍是 unverified —— 弱成功只能用于 WORKING 路径。
      ...(body.trim().length > 0 && shellWeakVetoHits(body).length === 0 ? { weak: "shell" } : {}),
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
    // S2a：只读工具返回了非空内容，且 ①isError ②退出码 ③测试计数 ④行首错误行 ⑤行首硬错误都没命中。
    // 这是「工具自报无错」，**不是**「有外部验证」⇒ 只给 WORKING 路径用，result 一个字不动。
    ...(readOnly && body.trim().length > 0 ? { weak: "read" } : {}),
  };
}

/**
 * 一条边算不算「弱成功」，以及是哪一种。**只在热清单的 WORKING 路径里使用。**
 *
 *   · 新图：settle 时由 classify 写入 `edge.weak = "read"`（keeper 透传）；
 *   · 旧图：settle 时已落盘 `verify.kind === "read"`（同一个 readOnly 判定的产物）——
 *     不需要 weak 字段也能识别，读旧图不会少一行 WORKING；
 *   · 只看 `result === "unverified"`：success / failure 上出现 weak 是脏数据（`validate()` 会报）。
 *
 * @returns {"read"|"shell"|null}  S2a 只产生 "read"；"shell" 预留给 S2b。
 */
export function weakKindOf(edge) {
  if (!edge || edge.result !== "unverified") return null;
  if (edge.weak === "read" || edge.weak === "shell") return edge.weak;
  // 旧图兼容：classify 的只读兜底分支会写 kind="read" + summary="N chars"（空输出是 "empty"）
  const summary = edge.verify?.summary;
  if (edge.verify?.kind === "read" && typeof summary === "string" && summary !== "empty") return "read";
  return null;
}

function firstLine(text) {
  const line = String(text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
}

export const _internal = { READ_ONLY_TOOLS, LOCAL_MUTATE_TOOLS, WRITE_TOOLS, SHELL_TOOLS, firstLine, lastLineExitCode, HARD_ERR_RE, ERR_LINE_RE, HARD_LINE_RE };
