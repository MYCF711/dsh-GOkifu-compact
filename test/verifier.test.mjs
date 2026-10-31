import { classify, errorSnippet, toolClass, lastLineExitCode, _internal } from "../src/rooms/verify.mjs";
import { intentFromAssistantText, actionSummary, touchedPaths } from "../src/rooms/keeper.mjs";

export const tests = {
  "exit 非 0 ⇒ failure（并抓到报错原文）"() {
    const r = classify({ tool: "bash", text: "Traceback (most recent call last):\n  File a.ts line 3\nTypeError: x\n[exit code: 1]" });
    if (r.result !== "failure") throw new Error(`应是 failure，得到 ${r.result}`);
    if (!r.errorSnippet.includes("TypeError")) throw new Error(`errorSnippet 丢原文：${r.errorSnippet}`);
    if (r.verify.kind !== "exit") throw new Error(`verify.kind=${r.verify.kind}`);
  },

  "exit 0 一律 success（退出码是最终裁决）"() {
    const r = classify({ tool: "bash", text: "error: closeError,\n[exit code: 0]" });
    if (r.result !== "success") throw new Error(`exit 0 应 success，得到 ${r.result}`);
  },

  "只读工具的 JSON 里出现「失败」不算 failure"() {
    const json = '{"goal":{"objective":"在目标完成或目标确实无法实现之前禁止终止任务","phase":"active"}}';
    if (classify({ tool: "get_goal", text: json }).result !== "unverified") throw new Error("get_goal");
    if (classify({ tool: "hindsight_search_knowledge_pages", text: "snippet: 升级会引回「失败 2 次」" }).result !== "unverified") throw new Error("hindsight");
    if (classify({ tool: "skill", text: "## 踩坑\n- 这样写会报错" }).result !== "unverified") throw new Error("skill");
  },

  "read 到的代码注释里含 EACCES 不算 failure"() {
    if (classify({ tool: "read", text: "// EACCES 时提示用户\nconst x = 1;" }).result !== "unverified") throw new Error("read 注释");
  },

  "read 真正的 ENOENT 仍算 failure"() {
    if (classify({ tool: "read", text: "ENOENT: no such file or directory, open 'a.ts'" }).result !== "failure") throw new Error("ENOENT");
  },

  "shell 没有退出码 ⇒ 不判定（后台任务/测试用例名）"() {
    const r = classify({ tool: "bash", text: "error: closeError,\n  stage: commit" });
    if (r.result !== "unverified") throw new Error(`无 exit 的 bash 应 unverified，得到 ${r.result}`);
    if (classify({ tool: "bash", text: "✓ 测试计数：3 passed ⇒ success；2 failed ⇒ failure" }).result !== "unverified") throw new Error("用例名");
  },

  "真错误仍然抓得住：exit≠0 / 行首 Error:"() {
    if (classify({ tool: "bash", text: "boom\n[exit code: 2]" }).result !== "failure") throw new Error("exit≠0");
    if (classify({ tool: "unknown_tool", text: "Error: bad thing" }).result !== "failure") throw new Error("行首 Error:");
  },

  "测试计数：非 shell 才认"() {
    if (classify({ tool: "test-report", text: "12 passing\n0 failing" }).result !== "success") throw new Error("passing");
    if (classify({ tool: "test-report", text: "12 passing\n2 failing" }).result !== "failure") throw new Error("failing");
    if (classify({ tool: "bash", text: "12 passing\n2 failing\n[exit code: 1]" }).result !== "failure") throw new Error("shell exit 1");
  },

  "写文件成功 ⇒ success（diff 规模进 verify）"() {
    const r = classify({ tool: "edit", text: "1 file changed, 12 insertions(+), 3 deletions(-)" });
    if (r.result !== "success") throw new Error("edit 应 success");
    if (r.verify.kind !== "diff") throw new Error(`kind=${r.verify.kind}`);
  },

  "只读工具 ⇒ unverified（不是 success）"() {
    for (const tool of ["read", "grep", "glob", "web_search"]) {
      if (classify({ tool, text: "some content" }).result !== "unverified") throw new Error(tool);
    }
  },

  "toolClass 分类"() {
    if (toolClass("bash") !== "shell") throw new Error("bash");
    if (toolClass("write") !== "write") throw new Error("write");
    if (toolClass("read") !== "read") throw new Error("read");
    if (toolClass("mcp__foo__search") !== "mcp-read") throw new Error("mcp search");
    if (toolClass("mcp__foo__delete") !== "mcp-write") throw new Error("mcp delete");
    if (toolClass("hindsight_recall") !== "mcp-read") throw new Error("hindsight_recall");
    if (toolClass("get_goal") !== "read") throw new Error("get_goal");
  },

  "errorSnippet：抓错误行、限长 400"() {
    const long = "line1\nline2\nError: x\nline4\nline5\n" + "z".repeat(500);
    const out = errorSnippet(long);
    if (!out.includes("Error: x")) throw new Error(`没抓到错误行：${out.slice(0, 20)}`);
    if (out.length > 400) throw new Error(`没截断：${out.length}`);
  },

  "errorSnippet 不会从注释里的 EACCES 开始"() {
    const text = "// 说明：EACCES 时提示\n正常代码\nError: 真正的报错";
    const out = errorSnippet(text);
    if (!out.includes("Error: 真正的报错")) throw new Error(`没抓到：${out.slice(0, 30)}`);
  },

  "意图抽取：剥掉「计划：」前缀且保留内容"() {
    const intent = intentFromAssistantText("先看一下文件。\n计划：整体解析 JSONL 文件。");
    if (intent.startsWith("计划")) throw new Error(`前缀没剥：${intent}`);
    if (!intent.includes("JSONL")) throw new Error(`内容丢了：${intent}`);
  },

  "动作摘要与路径抽取"() {
    const s = actionSummary("bash", { command: "npm test", timeout: 1000 });
    if (!s.startsWith("bash(") || !s.includes("npm test")) throw new Error(s);
    const paths = touchedPaths("edit", { file_path: "src/a.ts", content: "x" });
    if (!paths.includes("src/a.ts")) throw new Error(JSON.stringify(paths));
    if (paths.includes("x")) throw new Error("把 content 当路径了");
  },
};

/* ── 2026-10-29：errorSnippet 取「结论行」（实机 e373/e312 暴露出旧版取到的是噪声） ── */
Object.assign(tests, {
  "errorSnippet：Python traceback 取最后那条异常（不是 [stderr] + 第一帧）"() {
    const text = "[stderr]\nTraceback (most recent call last):\r\n  File \"<stdin>\", line 19, in <module>\r\nTypeError: 'int' object is not subscriptable";
    const out = errorSnippet(text);
    if (!out.includes("TypeError: 'int' object is not subscriptable")) throw new Error(`没取到结论行：${out}`);
    if (out.includes("[stderr]") || out.includes("most recent call last")) throw new Error(`还在取噪声：${out}`);
  },

  "errorSnippet：跳过 [stderr] 标记行，抓 sed 的结论"() {
    const out = errorSnippet("=== 上下文 ===\n[stderr]\nsed: -e expression #1, char 1: unknown command: `,'");
    if (!out.includes("sed: -e expression")) throw new Error(`没抓到 sed 行：${out}`);
    if (out.startsWith("[stderr]")) throw new Error(`开头还是标记行：${out}`);
  },

  "errorSnippet：node 的 Error: 行连同栈顶保留"() {
    const out = errorSnippet("Error: ENOENT: no such file or directory, open 'D:\\d\\x.md'\r\n    at Object.writeFileSync (node:fs:2483:20)");
    if (!out.startsWith("Error: ENOENT")) throw new Error(`没从 Error 行开始：${out}`);
    if (!out.includes("writeFileSync")) throw new Error(`没带上栈顶：${out}`);
  },

  "errorSnippet：traceback 末尾的 [exit code: 1] 不会被当成结论"() {
    const out = errorSnippet("Traceback (most recent call last):\n  File a.ts line 3\nTypeError: x\n[exit code: 1]");
    if (!out.includes("TypeError: x")) throw new Error(`取错了：${out}`);
    if (out.includes("[exit code")) throw new Error(`把退出码当结论了：${out}`);
  },
});


/* ═════════════ OPT-VERIFY（task-124）：exit 精确判据 + local-mutate ═════════════ */

Object.assign(tests, {
  "OPT-V-1 exit 只认「末条非空行整行等于 [exit code: N]」"() {
    // ① 末行精确 marker：0 ⇒ success，非 0 ⇒ failure
    if (classify({ tool: "bash", text: "ok\n[exit code: 0]" }).result !== "success") throw new Error("末行 exit 0 必须 success");
    if (classify({ tool: "bash", text: "boom\n[exit code: 3]" }).result !== "failure") throw new Error("末行 exit 3 必须 failure");
    if (classify({ tool: "bash", text: "[exit code: 3]" }).verify.summary !== "exit 3") throw new Error("summary 要写 exit 3");
    // ② 允许行内前后空白与 CRLF（宿主追加时可能带 \r）
    if (classify({ tool: "bash", text: "done\n  [exit code: 0]  " }).result !== "success") throw new Error("两侧空白必须容忍");
    if (classify({ tool: "bash", text: "done\r\n[exit code: 0]\r\n" }).result !== "success") throw new Error("CRLF 必须容忍");
    if (lastLineExitCode("a\n\n[exit code: 7]\n\n") !== 7) throw new Error("尾部空行要跳过");
    // ③ marker 不是末行 ⇒ 一律 no-exit（不猜）
    const notLast = classify({ tool: "bash", text: "[exit code: 1]\n还有后续输出" });
    if (notLast.result !== "unverified") throw new Error(`marker 不在末行不许当结论，实际 ${notLast.result}`);
    if (notLast.verify.kind !== "no-exit") throw new Error(`必须是 no-exit，实际 ${notLast.verify.kind}`);
    // ④ 正文子串（复核活证据 e8）：cat 出来的源码里写着 marker ⇒ 不许判 failure
    const catSource = classify({ tool: "bash", text: 'const text = "[exit code: 1]" + String(x);\nmodule.exports = text;' });
    if (catSource.result !== "unverified") throw new Error(`正文子串不许当退出码，实际 ${catSource.result}`);
    // ⑤ 长前缀 + 末行真 marker：仍然必须抓到（不受 200 字符窗口限制）
    const longPrefix = classify({ tool: "bash", text: "x".repeat(1200) + "\n[exit code: 4]" });
    if (longPrefix.result !== "failure" || longPrefix.verify.summary !== "exit 4") throw new Error("长输出 + 末行 marker 必须抓到");
    // ⑥ 没有 marker ⇒ no-exit，且不改 weak 行为（非空、无失败特征 ⇒ weak shell 仍在）
    const noExit = classify({ tool: "bash", text: "12 passing" });
    if (noExit.verify.kind !== "no-exit" || noExit.weak !== "shell") throw new Error("no-exit 行为不许变");
    // ⑦ lastLineExitCode 判据自检
    if (lastLineExitCode("") !== null) throw new Error("空输出 ⇒ null");
    if (lastLineExitCode("no marker here") !== null) throw new Error("无 marker ⇒ null");
    if (lastLineExitCode("[exit code: 0] trailing") !== null) throw new Error("行内后缀 ⇒ null（必须整行）");
  },

  "OPT-V-2 local-mutate：本地状态写入类工具 unverified + kind \"none\"、不带 weak"() {
    const must = [
      "todo_write", "update_goal", "create_goal", "hindsight_ingest_document",
      "team_task_create", "team_task_update", "send_message",
      "schedule_create", "schedule_update", "schedule_delete",
      "job_kill", "spawn_teammate", "subagent",
    ];
    for (const tool of must) {
      if (toolClass(tool) !== "local-mutate") throw new Error(`${tool} 必须分类为 local-mutate，实际 ${toolClass(tool)}`);
      const c = classify({ tool, text: "ok · 已完成" });
      if (c.result !== "unverified") throw new Error(`${tool} 必须 unverified，实际 ${c.result}`);
      if (c.verify.kind !== "none") throw new Error(`${tool} kind 必须是 none，实际 ${c.verify.kind}`);
      if (c.weak !== undefined) throw new Error(`${tool} 不许带 weak（会污染 WORKING 路径）`);
    }
    // 分组表本身：从 _internal 读，防止测试与实现各写一份
    for (const tool of must) if (!_internal.LOCAL_MUTATE_TOOLS.has(tool)) throw new Error(`${tool} 不在 LOCAL_MUTATE_TOOLS 里`);
    // 真正只读的仍然只读 + weak read
    for (const tool of ["read", "grep", "web_fetch", "list_agents", "job_output", "team_task_get", "get_goal"]) {
      if (toolClass(tool) !== "read") throw new Error(`${tool} 必须仍是 read，实际 ${toolClass(tool)}`);
    }
    const r = classify({ tool: "read", text: "some content" });
    if (r.result !== "unverified" || r.weak !== "read") throw new Error("只读工具仍必须 weak:read");
    // 仓库写入与 present 一个字节不改
    if (toolClass("present") !== "write") throw new Error("present 必须仍是 write");
    if (toolClass("write") !== "write" || toolClass("edit") !== "write") throw new Error("写工具分类不许变");
    const w = classify({ tool: "write", text: "1 insertion(+)" });
    if (w.result !== "success" || w.verify.kind !== "diff") throw new Error("write 回执仍必须 success/diff");
    // isError 优先级最高：local-mutate 被宿主标错时仍是 failure
    const e = classify({ tool: "todo_write", text: "boom", isError: true });
    if (e.result !== "failure" || e.verify.kind !== "host-error") throw new Error("isError 必须仍压过 local-mutate");
  },
});
