import { classify, errorSnippet, toolClass } from "../src/rooms/verify.mjs";
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
