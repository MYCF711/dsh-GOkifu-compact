/**
 * human-message.test.mjs —— 「假人话」守卫（T38）
 *
 * 事故（2026-11-05 真机审计 `scripts/human-message-audit.mjs`）：
 *
 *   session-f7f835b1 seq 1179 —— 一条 **251,157 字符**的 LLM 错误 JSON
 *   （`{"id":"chatcmpl-…","error":{…}}` + 用户粘上的请求体），宿主标的 `source.kind = "user"`。
 *   `isHumanMessage` 只看 `source.kind` ⇒ 当成「人打的字」⇒ `extractConstraints` 抽出
 *   **40 条「约束」** ⇒ 渲染进 `## 约束（一条都不许丢）`，整块 36% 是系统提示词。
 *
 * 修法：`isHumanMessage` 增加**闭集**判据（只认精确形状）+ **锚在开头**（正文里引用报错不算）
 * + **绝对主体**（机器产物占字符 ≥90%）。**保守优先：判不准就算人话** ——
 * 误判成机器会丢掉真实用户输入（不可恢复），留噪声只是多花 token。
 *
 * 本文件钉住两件事：
 *   ① **该红的红**：4 类机器产物（LLM 错误 JSON / 堆栈 / HTTP 响应 / 命令回执）
 *      **修前算人话、修后不算**（每条都显式断言了修前判据，删掉修复就会红）；
 *   ② **不该红的别红**：用户粘贴的 JSON 配置 / 代码块 / 正文里引用的报错 / 长代码
 *      一律仍算人话 —— 这些是真实用户输入，误判就丢了。
 *
 * 夹具全部来自真机会话（截断处已标注），不是编的。
 */
import { isHumanMessage } from "../src/rooms/keeper.mjs";
import { classifyMachineOutput, MACHINE_SHARE } from "../scripts/human-message-audit.mjs";

export const tests = {};

/** 一条 user 消息（`content` 用块数组，与宿主真实形状一致）。 */
const msg = (text, kind = "user") => ({ source: { kind }, content: [{ type: "text", text }] });

/**
 * **修前判据**（`kind ∈ {user,prompt,human}` 即算人话）—— 只在夹具里复现，
 * 用来证明「这些正文在修前确实被当成人话」。它不许参与生产逻辑。
 */
const legacyIsHuman = (message) => ["user", "prompt", "human"].includes(String(message?.source?.kind ?? ""));

/**
 * 真机夹具 ①：session-f7f835b1 seq 1179（**251,157 字符**，此处按原文截断）。
 *
 * 结构：`{错误信封}` + 用户一句「还是有问题」+ `{完整请求体，尾部被截断}`。
 * 两个特征都必须吃住：**开头的信封**（判据的形状）与**尾部的截断 JSON**（覆盖率算机器）。
 */
const LLM_ERROR_JSON = String.raw`{
  "id": "chatcmpl-18e446e2e59d981800000002",
  "model": "group/deepseek-v4.1-flash1017",
  "error": {
    "message": "WPS 灵犀 Lingxi: 灵犀上游返回 AuditFailed：我还在不断学习中，暂时无法回答此问题，请尝试重新提问（请求或内容有问题，重试无效）",
    "type": "api_error"
  }
}
还是有问题
{"model":"group/deepseek-v4.1-flash1017","messages":[{"role":"developer","content":"Runtime: DeepSeek Harness.\n\n\nYou are a general-purpose agent powered by the group/deepseek-v4.1-flash1017 model.\n\n# 团队与分工\n\n本会话可能挂载了团队（Lead + 若干 teammate）与子代理。它们和你共享同一工作目录和文件系统，任何一方的改动立刻对其他人可见。\n\n- **默认外派**：只要子任务不依赖我刚积累的上下文，就派出去；只有必须在本会话连续处理的（需要全局取舍、要和用户来回、依赖刚读到的内容）才自己留。\n- **派给谁**：一次性调研/实现/验证 → 子代理；需要专长、需要持续协作、或它的上下文更合适 → 团队成员。\n- 任务书写死：目标、边界（能改哪些文件）、验收标准、产出路径。含糊的任务回来还得回炉。\n- 写作用域按文件切开，任务板上记下各自负责的路径；有依赖就用任务依赖排顺序。\n- **同时派，不要排队**：有 2 个以上互不依赖的块就一起派出去；有前后依赖才串行。别为了并行而并行——拆完还要有人合并、有人验收。\n- Lead 收尾前必须等所有必需成员完成，并自己跑一遍最终验证。\n`;

/**
 * 真机夹具 ②：session-ed98c462 seq 8（1,950 字符，此处按原文截断）——
 * OpenAI `choices` 响应 + `error` 信封，末尾跟用户一句「找报错根因」。
 */
const OPENAI_CHOICES_JSON = String.raw`{
  "id": "chatcmpl-lingxi-1793587914",
  "model": "deepseek-v4.1-flash",
  "choices": [
    {
      "type": "message",
      "content": "",
      "reasoning": "Now 2 reference candidates (tool:github path ×8 episodes, tool:github contents ×5). Weak but real. Worth shipping as reference layer with honest labeling."
    },
    {
      "type": "tool_call",
      "id": "call_00_z1rr38xzri7hes8q2iw7q9tq",
      "name": "bash",
      "arguments": "{\"command\": \"cd /d/DeepSeek Harness/default-workspace && node scripts/archive.mjs --dry-run 2>&1 | head -3\"}"
    }
  ],
  "error": {
    "message": "灵犀上游返回 AIError：AI服务异常",
    "type": "upstream_error",
    "code": "upstream_error"
  }
}
找报错根因`;

/** 真机夹具 ③：session-ee0d63a9 seq 1431（937 字符，原文）—— pnpm 安装回执 + V8 栈帧。 */
const PNPM_RECEIPT = String.raw`[WARN] The store at <USER_HOME>\AppData\Local\pnpm\store\v11 is not used because packages cannot be hard linked from it into this project. Using the store at D:\.pnpm-store\v11 instead. Set storeDir to choose the store.
✓ Lockfile passes supply-chain policies (verified 54s ago)
Progress: resolved 1, reused 0, downloaded 0, added 0
[UNABLE_TO_GET_ISSUER_CERT_LOCALLY] unable to get local issuer certificate

This error happened while installing a direct dependency of D:\DeepSeek Harness\home\profiles\desktop

Error: unable to get local issuer certificate
    at TLSSocket.onConnectSecure (node:internal/tls/wrap:1775:34)
    at TLSSocket.emit (node:events:514:28)
    at TLSSocket._finishInit (node:internal/tls/wrap:1203:8)
    at ssl.onhandshakedone (node:internal/tls/wrap:984:12)
[WARN] GET https://registry.npmmirror.com/dsh-pause-resume error (UND_ERR_DESTROYED). Will retry in 10 seconds. 2 retries left.`;

/** Python 堆栈（`Traceback` 开头 —— 强形状）。 */
const PYTHON_TRACEBACK = String.raw`Traceback (most recent call last):
  File "D:\repo\scripts\build.py", line 12, in <module>
    main()
  File "D:\repo\scripts\build.py", line 8, in main
    raise RuntimeError("boom")
RuntimeError: boom`;

/** `curl -i` 的响应转储（状态行开头 —— 强形状；头行/JSON 正文是弱形状，只凑覆盖率）。 */
const HTTP_RESPONSE = String.raw`HTTP/1.1 502 Bad Gateway
Content-Type: application/json
Content-Length: 84
Connection: keep-alive

{"error":{"message":"upstream connect error","type":"api_error"}}`;

/** `Error:` 行 + V8 栈帧 —— 首行是**弱**形状，靠后面的强形状（栈帧）佐证。 */
const NODE_STACK = String.raw`Error: ENOENT: no such file or directory, open 'D:\repo\dist\index.js'
    at Object.openSync (node:fs:596:3)
    at Object.readFileSync (node:fs:496:3)
    at Module._compile (node:internal/modules/cjs/loader:1105:14)`;

/** 用户粘贴的 JSON 配置（顶层没有 `error` / `choices`，`id` 也不是 `chatcmpl-`）—— 必须算人话。 */
const USER_JSON_CONFIG = String.raw`{
  "name": "dsh-gokifu-compact",
  "version": "0.13.0",
  "scripts": {
    "test": "node test/run.mjs"
  },
  "id": "my-service",
  "dependencies": {
    "zod": "^3.23.0"
  }
}`;

/** 用户粘贴的 JSON 数组（不是 OpenAI 信封）—— 必须算人话。 */
const USER_JSON_ARRAY = String.raw`[
  { "file": "src/rooms/keeper.mjs", "line": 204 },
  { "file": "test/human-message.test.mjs", "line": 1 }
]`;

/** 用户写的代码块 —— 必须算人话。（用数组拼，免得模板字面量把 ``` 吃掉） */
const USER_CODE_BLOCK = [
  "```js",
  "export function isHumanMessage(message) {",
  "  const kind = message?.source?.kind;",
  "  if (kind === undefined || kind === null) return false;",
  "  return HUMAN_SOURCES.has(String(kind));",
  "}",
  "```",
  "",
  "上面这个判据漏了「机器输出」，改成什么好？",
].join("\n");

/** 用户**引用**报错（正文里贴日志，再问「怎么修」）—— 形状不在开头，必须算人话。 */
const USER_QUOTED_TRACEBACK = [
  "我跑 npm test 报错，帮我看看怎么修：",
  "",
  "```",
  String.raw`Traceback (most recent call last):`,
  String.raw`  File "D:\repo\scripts\build.py", line 12, in <module>`,
  "    main()",
  "RuntimeError: boom",
  "```",
  "",
  "顺带一提，[WARN] 那行可以忽略。",
].join("\n");

/** 短错误 JSON + 长人类说明 —— 机器产物占比 < 90%，按保守优先算人话。 */
const SHORT_ERROR_JSON_LONG_QUESTION = String.raw`{"error":{"code":500,"message":"upstream connect error","type":"api_error"}}
这个报错是刚才那次请求打出来的，我当时在跑 archive 的 dry-run，前面一切正常，
只有这一步挂掉了。我怀疑是网关把上游的 502 包装成了 api_error，但不确定是不是
我们自己的 keep-alive 超时导致的 —— 先帮我确认这个错误是上游产生的还是本地产生的，
如果是上游产生的，那我们的重试策略是不是应该跳过这种错误？`;

/**
 * 一条**很长**的代码粘贴（200 行）。长度不是判据 —— 长代码仍然是真实用户输入。
 * @returns {string}
 */
const LONG_CODE_PASTE = ["export const ROUTES = {", ...Array.from({ length: 200 }, (_, i) => `  "/api/v${i}": handler${i},`), "};"].join("\n");

/** markdown 清单（以 `[` 开头，但不是 JSON）—— 必须算人话。 */
const MARKDOWN_CHECKLIST = String.raw`[ ] 把 isHumanMessage 的判据写成闭集
[ ] 给真机 3 条假人话各写一个夹具
[x] 跑 human-message-audit`;

tests["T38-1 真机 seq 1179：251k 的 LLM 错误 JSON —— 修前算人话，修后不算"] = (t) => {
  const message = msg(LLM_ERROR_JSON);
  t.eq(legacyIsHuman(message), true, "修前判据（只看 source.kind）必须把它当人话 —— 这是事故现场");
  t.eq(isHumanMessage(message), false, "修后：LLM 错误 JSON 不是人打的字（否则 40 条约束锚继续污染事实块）");
  t.eq(classifyMachineOutput(LLM_ERROR_JSON).kind, "error-json", "分类 = error-json");
  // 尾部那句人类残留（「还是有问题」）占比必须远低于闸门 —— 否则这个夹具证明不了覆盖率判据。
  t.ok(classifyMachineOutput(LLM_ERROR_JSON).share > 0.95, `机器产物占比应 >95%，实际 ${classifyMachineOutput(LLM_ERROR_JSON).share.toFixed(4)}`);
};

tests["T38-2 真机 seq 8：OpenAI choices 响应 +「找报错根因」—— 不算人话"] = (t) => {
  const message = msg(OPENAI_CHOICES_JSON);
  t.eq(legacyIsHuman(message), true, "修前算人话");
  t.eq(isHumanMessage(message), false, "修后不算");
  t.eq(classifyMachineOutput(OPENAI_CHOICES_JSON).kind, "error-json", "分类 = error-json");
};

tests["T38-3 真机 seq 1431：pnpm 安装回执 + V8 栈帧 —— 不算人话"] = (t) => {
  const message = msg(PNPM_RECEIPT);
  t.eq(legacyIsHuman(message), true, "修前算人话");
  t.eq(isHumanMessage(message), false, "修后不算");
  t.eq(classifyMachineOutput(PNPM_RECEIPT).kind, "tool-receipt", "分类 = tool-receipt");
};

tests["T38-4 Python 堆栈（Traceback 开头）—— 不算人话"] = (t) => {
  const message = msg(PYTHON_TRACEBACK);
  t.eq(legacyIsHuman(message), true, "修前算人话");
  t.eq(isHumanMessage(message), false, "修后不算");
  t.eq(classifyMachineOutput(PYTHON_TRACEBACK).kind, "stack-trace", "分类 = stack-trace");
};

tests["T38-5 HTTP 响应转储（状态行开头）—— 不算人话"] = (t) => {
  const message = msg(HTTP_RESPONSE);
  t.eq(legacyIsHuman(message), true, "修前算人话");
  t.eq(isHumanMessage(message), false, "修后不算");
  t.eq(classifyMachineOutput(HTTP_RESPONSE).kind, "http-response", "分类 = http-response");
};

tests["T38-6 `Error:` 行 + V8 栈帧（弱行必须有强行佐证）—— 不算人话"] = (t) => {
  const message = msg(NODE_STACK);
  t.eq(legacyIsHuman(message), true, "修前算人话");
  t.eq(isHumanMessage(message), false, "修后不算");
  t.eq(classifyMachineOutput(NODE_STACK).kind, "stack-trace", "分类 = stack-trace");
};

tests["T38-7 ★真·人话：用户粘贴的 JSON 配置（顶层 id 不是 chatcmpl）"] = (t) => {
  t.eq(isHumanMessage(msg(USER_JSON_CONFIG)), true, "JSON 配置里也有 id —— 但顶层没有 error/choices，也不是 chatcmpl 前缀");
  t.eq(classifyMachineOutput(USER_JSON_CONFIG).kind, "真·人话", "分类 = 真·人话");
  t.eq(isHumanMessage(msg(USER_JSON_CONFIG + "\n\n这个配置为什么起不来？")), true, "配置 + 一句问题，仍然是真实输入");
};

tests["T38-8 ★真·人话：用户粘贴的 JSON 数组（不是 OpenAI 信封）"] = (t) => {
  t.eq(isHumanMessage(msg(USER_JSON_ARRAY)), true, "数组不是信封");
  t.eq(classifyMachineOutput(USER_JSON_ARRAY).kind, "真·人话", "分类 = 真·人话");
};

tests["T38-9 ★真·人话：用户写的代码块"] = (t) => {
  t.eq(isHumanMessage(msg(USER_CODE_BLOCK)), true, "代码块以 ``` 开头，不是任何机器形状");
  t.eq(classifyMachineOutput(USER_CODE_BLOCK).kind, "真·人话", "分类 = 真·人话");
};

tests["T38-10 ★真·人话：正文里**引用**了 Traceback（形状不在开头）"] = (t) => {
  t.eq(isHumanMessage(msg(USER_QUOTED_TRACEBACK)), true, "贴日志再问「怎么修」是最常见的真实输入 —— 锚在开头就是为它");
  t.eq(classifyMachineOutput(USER_QUOTED_TRACEBACK).kind, "真·人话", "分类 = 真·人话");
};

tests["T38-11 ★真·人话：短错误 JSON + 长问题（机器占比 < 闸门）"] = (t) => {
  const share = classifyMachineOutput(SHORT_ERROR_JSON_LONG_QUESTION).share;
  t.ok(share < MACHINE_SHARE, `机器产物占比 ${share.toFixed(4)} 应 < 闸门 ${MACHINE_SHARE}`);
  t.eq(isHumanMessage(msg(SHORT_ERROR_JSON_LONG_QUESTION)), true, "保守优先：机器不是主体 ⇒ 人话");
};

tests["T38-12 ★真·人话：超长代码粘贴（长度不是判据）"] = (t) => {
  t.eq(LONG_CODE_PASTE.length > 4000, true, "夹具要够长（>4000 字符）才证明得了「长度不是判据」");
  t.eq(isHumanMessage(msg(LONG_CODE_PASTE)), true, "长代码仍然是真实用户输入");
  t.eq(isHumanMessage(msg(LONG_CODE_PASTE + "\n\n这段能编译过吗？")), true, "长代码 + 一句问题");
};

tests["T38-13 ★真·人话：markdown 清单（以 [ 开头但不是 JSON）"] = (t) => {
  t.eq(isHumanMessage(msg(MARKDOWN_CHECKLIST)), true, "`[ ] 任务` 不是 JSON 文档");
  t.eq(isHumanMessage(msg("   \n\t  \n")), true, "纯空白：保守算人话（observeEvent 另有兜底）");
};

tests["T38-14 旧格式与注入来源的行为**不变**（这次只动了机器产物那一段）"] = (t) => {
  t.eq(isHumanMessage({ content: "没有 source 的旧格式" }), false, "无 source ⇒ 保守当注入");
  t.eq(isHumanMessage({ source: {}, content: "kind 缺失" }), false, "kind 缺失 ⇒ 保守当注入");
  for (const kind of ["runtime-context", "agent-instructions", "skill-catalog", "chess-context", "compact-checkpoint", "plugin:hindsight", "time-context"]) {
    t.eq(isHumanMessage(msg("注入内容", kind)), false, `${kind} 仍不算人话`);
  }
  t.eq(isHumanMessage(msg("真的人话")), true, "普通用户消息仍算人话");
  t.eq(isHumanMessage(msg("人话", "prompt")), true, "prompt 仍算人话");
  t.eq(isHumanMessage(msg("人话", "human")), true, "human 仍算人话");
};

tests["T38-15 审计脚本的**独立实现**与生产判据逐条一致（漂了要红）"] = (t) => {
  const fixtures = [
    LLM_ERROR_JSON,
    OPENAI_CHOICES_JSON,
    PNPM_RECEIPT,
    PYTHON_TRACEBACK,
    HTTP_RESPONSE,
    NODE_STACK,
    USER_JSON_CONFIG,
    USER_JSON_ARRAY,
    USER_CODE_BLOCK,
    USER_QUOTED_TRACEBACK,
    SHORT_ERROR_JSON_LONG_QUESTION,
    LONG_CODE_PASTE,
    MARKDOWN_CHECKLIST,
  ];
  for (const text of fixtures) {
    const oracle = classifyMachineOutput(text).kind !== "真·人话";
    const production = !isHumanMessage(msg(text));
    t.eq(production, oracle, `两边判据必须一致：${text.slice(0, 40).replace(/\s+/g, " ")}`);
  }
};
