/**
 * tool-value-facts.test.mjs —— AX-02 值型事实抽取器的纯函数直测（2026-11-07）
 *
 * 为什么必须单测：这个房间是「成功工具结果 → 短值」的唯一入口。它错一格，
 * 下游（AX-04 落盘 / AX-08 注入 / K-2 reader）拿到的就是**看起来有证据、实际回证不了**的事实 ——
 * 那比没有事实更糟（K-26 的 quote 逐字规则就是为此立的）。
 *
 * 夹具（`test/fixtures/tool-value-facts.json`）的两个退化形状来自 K-2 实测：
 *   · `evidence/k2-reader-expand-2026-11-07.json` S1-Q1：成功 write 的 Created file；
 *   · 同文件 S2-Q3：仓库 API JSON 的 id/private。
 * 每条都同时给**正例**（必须抽出来）与**反例**（同样文字但不是成功结果/没有 id/数组回显时，必须抽空）。
 *
 * 另有一组**生成式**用例（300 KB JSON、maxFacts 截断、冻结输入）—— 它们无法写进 JSON 夹具，
 * 但正是「大结果只保留有证据短值」「纯函数」两条验收的机器判据。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  VALUE_FACT_KINDS,
  VALUE_FACT_LIMITS,
  extractValueFacts,
  githubReadShaped,
  isValueFact,
  normalizeToolName,
  resultKindForValueFacts,
  toolNameFromAction,
  toolNameFromSource,
} from "../src/rooms/tool-value-facts.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = nodePath.join(HERE, "fixtures", "tool-value-facts.json");
const FIXTURE = JSON.parse(nodeFs.readFileSync(FIXTURE_PATH, "utf8"));
const CASES = new Map(FIXTURE.cases.map((entry) => [entry.id, entry]));

/** 取一条夹具；缺了就直接红（不允许「夹具没了 ⇒ 用例静默跳过」）。 */
function fixture(id) {
  const found = CASES.get(id);
  if (!found) throw new Error(`夹具缺 ${id}`);
  return found;
}

/** 跑一条夹具，返回 facts。 */
function runFixture(id) {
  const entry = fixture(id);
  return extractValueFacts(entry.input);
}

/** 只比 (kind, value) —— quote/seq 由契约用例统一检查。 */
function kindValuePairs(facts) {
  return facts.map((fact) => [fact.kind, fact.value]);
}

/** 递归冻结：证明抽取器不修改输入（包括 args）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const FACT_KEYS = ["evidenceSeq", "kind", "quote", "source", "validAtSeq", "value"];

/**
 * ★ AX-22 夹具：`read` 回的文件正文（形状逐字来自 K-2 真机会话 —— `N: ` 行号前缀 + 文档注释 +
 * 对象字面量；路径与 provider 名是**合成值**，不含任何私有会话正文）。
 */
const READ_CONTENT_JS = [
  "<path>/d/work/demo/src/providers.js</path>",
  "<type>file</type>",
  "<content>",
  "1: /**",
  "2:  * 文档注释：这一行是散文，不是值。",
  "3:  */",
  "4: export const PROVIDERS = [",
  "5:   {",
  "6:     id: 'codearts',",
  "7:     label: 'CodeArts (华为云)',",
  "8:   },",
  "9: ];",
  "</content>",
].join("\n");

/**
 * ★ AX-22 夹具：GitHub `contents` API 的**顶层 JSON 数组**（K2-N5 / K2-N6 的真实形状：
 * 目录列表 → 每个元素是 {name, path, sha, size, url, …}；`url` 这类长字段必须被跳过）。
 * 尾部还挂了标量元素（字符串 / 数字 / 布尔）证明「标量元素」这一支也抽。
 */
const CONTENTS_ARRAY_JSON = [
  '[{"name":"accio-adapter.d.ts","path":"vendor/lib/accio-adapter.d.ts",',
  '"sha":"c6f9d7a186c54e87f79007f6e08626dcb8701e8c","size":23738,',
  '"url":"https://api.github.com/repos/o/r/contents/vendor/lib/accio-adapter.d.ts?ref=x","type":"file"},',
  '"plain-scalar",42,true]',
].join("");

export const tests = {
  "夹具完整性：每条都有 id/why/input/expect，且 K-2 两个退化形状都在"(t) {
    t.ok(Array.isArray(FIXTURE.cases) && FIXTURE.cases.length >= 15, "夹具必须有足够用例（防止被删空后全绿）");
    const ids = new Set();
    for (const entry of FIXTURE.cases) {
      t.ok(typeof entry.id === "string" && entry.id !== "", "每条夹具都要有 id");
      t.ok(!ids.has(entry.id), `夹具 id 重复：${entry.id}`);
      ids.add(entry.id);
      t.ok(typeof entry.why === "string" && entry.why !== "", `${entry.id} 缺 why（为什么这个形状值得测）`);
      t.ok(entry.input !== null && typeof entry.input === "object", `${entry.id} 缺 input`);
      t.ok(entry.expect !== null && typeof entry.expect === "object" && Array.isArray(entry.expect.facts), `${entry.id} 缺 expect.facts`);
    }
    for (const id of ["k2-write-created-file", "k2-api-json-id-private"]) t.ok(ids.has(id), `缺少 K-2 退化形状用例 ${id}`);
  },

  "契约（全域）：每条事实恰好六个字段、通过 isValueFact、quote 是结果原文的逐字子串"(t) {
    for (const entry of FIXTURE.cases) {
      const facts = extractValueFacts(entry.input);
      for (const fact of facts) {
        t.ok(isValueFact(fact), `${entry.id}: isValueFact 拒绝 ${JSON.stringify(fact)}`);
        t.eq(Object.keys(fact).sort(), FACT_KEYS, `${entry.id}: 字段集合必须恰好是契约那六个`);
        t.ok(VALUE_FACT_KINDS.includes(fact.kind), `${entry.id}: 未知 kind ${fact.kind}`);
        if (typeof entry.input.result === "string") {
          t.ok(entry.input.result.includes(fact.quote), `${entry.id}: quote 不是原文逐字子串：${JSON.stringify(fact.quote)}`);
        }
      }
    }
  },

  "K-2 退化形状①：成功 write 的 Created file + 路径必须抽成一条可回证事实"(t) {
    const facts = runFixture("k2-write-created-file");
    t.eq(facts.length, 1, "成功 write 只该有一条文件事实（不回灌整份结果）");
    const fact = facts[0];
    t.eq(fact.kind, "file_created", "kind 必须区分 created/updated");
    t.eq(fact.value, "/d/work/demo/src/app.mjs", "value 必须是路径原文（不裁剪、不改写）");
    t.eq(fact.evidenceSeq, 154, "evidenceSeq 必须指向 tool/result 事件");
    t.eq(fact.validAtSeq, 154, "缺省 validAtSeq = evidenceSeq");
    t.eq(fact.source, "tool:write", "source 必须能看出工具来源");
    t.includes(fact.quote, "Created file", "quote 必须保留 Created file 字样（K-2 丢的就是它）");
    t.includes(fact.quote, "/d/work/demo/src/app.mjs", "quote 必须包含路径");
    t.ok(fact.quote.length <= VALUE_FACT_LIMITS.maxQuoteChars, "quote 必须短（不许把整份结果当证据）");
  },

  "K-2 退化形状①反例：同一段回执若判失败/宿主报错，不得产生成功值事实"(t) {
    t.eq(runFixture("k2-write-created-file-failure"), [], "resultKind=failure 必须空");
    t.eq(runFixture("k2-write-created-file-iserror"), [], "isError=true 必须空");
    // 反例再反证一次：把同一段文字标成 success，事实必须回来（证明上面的空不是夹具写坏）
    t.eq(runFixture("k2-write-created-file").length, 1, "成功态必须仍抽得出（否则反例是假绿）");
  },

  "K-2 退化形状②：API JSON 的 id/private 保留原类型，false 不许被当「没有」丢掉"(t) {
    const facts = runFixture("k2-api-json-id-private");
    t.eq(kindValuePairs(facts), [
      ["id", 4242],
      ["id", "R_demo4242"],
      ["boolean", false],
      ["config", "main"],
      ["config", "JavaScript"],
      ["boolean", true],
    ], "id/boolean/config 必须按原类型、按文档顺序抽出");
    const id = facts.find((fact) => fact.kind === "id" && fact.value === 4242);
    t.eq(typeof id.value, "number", "数字 id 不许被字符串化");
    const priv = facts.find((fact) => fact.kind === "boolean");
    t.eq(priv.value, false, "private=false 必须保留（falsy 不等于 absent）");
    t.includes(priv.quote, "\"private\": false", "quote 必须带键名（value 本身只说 false，看不出是哪个键）");
    t.eq(facts.some((fact) => fact.value === "a deliberately long description that must never become a value fact"), false, "长描述不许成为事实");
  },

  "K-2 退化形状②反例：结果没有 id 键就不编造 id，也不拿 name/full_name 冒充"(t) {
    const facts = runFixture("k2-api-json-no-id");
    t.eq(facts.map((fact) => fact.kind), ["boolean"], "无 id 时只该有 private 这一条");
    t.eq(facts.some((fact) => fact.kind === "id"), false, "不许编造 id");
    t.eq(facts.some((fact) => fact.value === "demo-repo" || fact.value === "octo/demo-repo"), false, "不许把 name/full_name 当 id");
  },

  "结果信任闸：weak（工具自报无错）可作值来源，unverified/failure 仍拒绝（不许蒙混）"(t) {
    t.eq(kindValuePairs(runFixture("k2-api-json-id-private-weak")), [["id", 4242], ["boolean", false], ["config", "main"]], "weak 读结果必须能抽（K-2 S2-Q3 的真实形态）");
    t.eq(runFixture("k2-api-json-id-private-unverified"), [], "unverified 且无 weak 必须空");
    t.eq(runFixture("k2-write-created-file-failure"), [], "failure 必须空");
    t.eq(extractValueFacts({ tool: "x", result: "{\"id\":1}", resultKind: "success", isError: true, evidenceSeq: 1 }), [], "isError 优先于 resultKind");
    t.eq(extractValueFacts({ tool: "x", result: "{\"id\":1}", resultKind: "weird", evidenceSeq: 1 }), [], "未知 resultKind 必须空");
  },

  "真机 JSON 形态：尾随 [exit code: 0] 与截断结果，都只从完整前缀里取短值"(t) {
    t.eq(kindValuePairs(runFixture("shell-json-with-exit-line")), [["id", 4242], ["boolean", false], ["config", "main"]], "JSON 后面的退出码行不该让整份结果失效");
    t.eq(kindValuePairs(runFixture("truncated-json-prefix")), [["id", 4242], ["boolean", true]], "截断处之前的完整成员仍可抽");
    const truncated = runFixture("truncated-json-prefix");
    for (const fact of truncated) {
      t.ok(!fact.quote.includes("items"), "截断成员不得成为证据");
      t.ok(!fact.quote.includes("[exit code"), "退出码行不得成为证据");
    }
    // 反证：同一份数据完整时结果一致（证明抽取不是因为截断而改变语义）
    const complete = extractValueFacts({ tool: "bash", result: "{\"id\": 4242, \"private\": true}", evidenceSeq: 3233 });
    t.eq(kindValuePairs(complete), [["id", 4242], ["boolean", true]], "完整 JSON 的抽取结果与截断前缀一致");
  },

  "错误结果不得进入成功值事实：JSON 自带 error / ok:false / status:error 一律空"(t) {
    t.eq(runFixture("k2-api-json-error"), [], "带 error 成员的 JSON 不是成功值");
    t.eq(extractValueFacts({ tool: "github", result: "{\"ok\":false,\"id\":1}", evidenceSeq: 5 }), [], "ok:false 是错误结果");
    t.eq(extractValueFacts({ tool: "github", result: "{\"status\":\"error\",\"id\":1}", evidenceSeq: 5 }), [], "status:error 是错误结果");
    t.eq(extractValueFacts({ tool: "bash", result: "TypeError: boom", evidenceSeq: 5 }), [], "错误行不是值");
    t.eq(runFixture("truncated-error-json"), [], "截断前缀里已有 ok:false ⇒ 空");
    t.eq(runFixture("json-nonzero-exit"), [], "末尾 exit code 非零 ⇒ 空（即使调用方标了 success）");
  },

  "数组实参不得当返回值：args 不参与抽取，顶层数组/读到的数组都不按元素抽"(t) {
    t.eq(runFixture("k2-array-result"), [], "顶层 JSON 数组一律空");
    t.eq(runFixture("k2-array-args-not-value"), [], "args 里的 id/数组不得成为事实（结果非空也不许）");
    const withArgs = extractValueFacts({
      tool: "write",
      result: "<path>/d/work/demo/a.mjs</path>\n<type>file</type>\n<content>\nCreated file\n</content>",
      evidenceSeq: 328,
      args: { id: 777, private: true, items: ["a", "b"] },
    });
    t.eq(kindValuePairs(withArgs), [["file_created", "/d/work/demo/a.mjs"]], "成功 write 的事实只能来自结果，args 不得混入");
    t.eq(withArgs.some((fact) => fact.value === 777 || fact.kind === "boolean"), false, "args 的 id/boolean 一条都不许出现");
    t.eq(
      runFixture("read-envelope-json-array"),
      [{ kind: "file_path", value: "/d/work/demo/list.json", quote: "<path>/d/work/demo/list.json</path>", evidenceSeq: 342, validAtSeq: 342, source: "tool:read" }],
      "读到的 JSON 数组只留路径，不按元素抽",
    );
    // 反证：同样的数据放在对象里就该被抽（证明「数组」而不是「这些值」被挡）
    const fromObject = extractValueFacts({ tool: "x", result: "{\"id\":1,\"private\":true}", evidenceSeq: 6 });
    t.eq(kindValuePairs(fromObject), [["id", 1], ["boolean", true]], "对象形态必须能抽");
  },

  "其他成功形状：Updated file / edit 回执 / read 路径各留一条，互不重复"(t) {
    t.eq(kindValuePairs(runFixture("write-updated-file")), [["file_updated", "/d/work/demo/README.md"]], "Updated file");
    t.eq(kindValuePairs(runFixture("edit-sentence")), [["file_updated", "/d/work/demo/src/util.mjs"]], "edit 回执只能一条（整句再当 value 就是重复）");
    t.eq(kindValuePairs(runFixture("read-envelope-path")), [["file_path", "/d/work/demo/src/index.mjs"]], "read 只留路径");
    const read = runFixture("read-envelope-path")[0];
    t.eq(read.quote, "<path>/d/work/demo/src/index.mjs</path>", "read 的 quote 只到路径行");
    t.notIncludes(read.quote, "export const", "read 正文不得进入 quote");
  },

  "read 到的 JSON：剥掉行号前缀解析，但 quote 必须映射回带原格式的原文"(t) {
    const facts = runFixture("read-envelope-json-config");
    t.eq(kindValuePairs(facts), [
      ["file_path", "/d/work/demo/settings.json"],
      ["config", 0.45],
      ["boolean", false],
      ["config", 500],
    ], "路径 + 三个配置短值");
    const ratio = facts.find((fact) => fact.value === 0.45);
    t.eq(ratio.quote, "\"thresholdRatio\": 0.45", "quote 必须保留原空格（从原文切，不是重新序列化）");
    t.notIncludes(ratio.quote, "2: ", "quote 不得带上 read 的行号前缀");
    const guard = facts.find((fact) => fact.kind === "boolean");
    t.eq(guard.value, false, "factGuard=false 必须保留");
    t.eq(guard.quote, "\"factGuard\": false", "quote 逐字");
  },

  "纯文本：单行短输出是值；寒暄、多行文本不是"(t) {
    t.eq(kindValuePairs(runFixture("short-plain-value")), [["value", "MINGW64_NT-10.0-26200"]], "单行短值");
    t.eq(runFixture("ack-not-value"), [], "done 不是值");
    t.eq(runFixture("prose-not-value"), [], "多行文本不猜");
    t.eq(extractValueFacts({ tool: "bash", result: "[exit code: 0]", evidenceSeq: 3 }), [], "退出码标记不是值");
  },

  "证据指针：没有 seq 不产事实；validAtSeq 缺省=evidenceSeq、可显式覆盖；非法 seq 空数组"(t) {
    t.eq(runFixture("missing-evidence-seq"), [], "缺 evidenceSeq 必须空");
    const overridden = extractValueFacts({
      tool: "write",
      result: "<path>/d/work/a.mjs</path>\n<type>file</type>\n<content>\nCreated file\n</content>",
      evidenceSeq: 10,
      validAtSeq: 20,
    });
    t.eq(overridden[0].evidenceSeq, 10, "evidenceSeq 保持结果事件");
    t.eq(overridden[0].validAtSeq, 20, "validAtSeq 可显式覆盖");
    for (const bad of [undefined, null, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "12"]) {
      t.eq(extractValueFacts({ tool: "write", result: "Created file", evidenceSeq: bad }), [], `非法 evidenceSeq=${String(bad)} 必须空`);
    }
    t.eq(
      extractValueFacts({ tool: "write", result: "{\"id\":1}", evidenceSeq: 1, validAtSeq: 1.5 }),
      [],
      "非法 validAtSeq 必须空（不许回落成 evidenceSeq 静默通过）",
    );
  },

  "大结果只保留有证据短值：300 KB JSON 只留 id/private，嵌套数组一条不出"(t) {
    const big = JSON.stringify({
      id: 7,
      private: true,
      description: "y".repeat(300_000),
      items: Array.from({ length: 200 }, (_, index) => ({ id: index, private: index % 2 === 0 })),
    });
    t.ok(big.length > 300_000, "夹具必须真的很大");
    const facts = extractValueFacts({ tool: "github", result: big, evidenceSeq: 900 });
    t.eq(kindValuePairs(facts), [["id", 7], ["boolean", true]], "只留两个短标量");
    const totalChars = facts.reduce((sum, fact) => sum + fact.quote.length + String(fact.value).length, 0);
    t.ok(totalChars < 120, `事实总量必须远小于结果（实际 ${totalChars} 字符 / 结果 ${big.length} 字符）`);
    for (const fact of facts) {
      t.ok(big.includes(fact.quote), "大结果里的 quote 也必须逐字");
      t.ok(!fact.quote.includes("items"), "嵌套数组不得成为证据");
    }
  },

  "maxFacts 上限与去重：配置 JSON 只留前 N 条，重复键不重复，两次结果完全一致"(t) {
    const raw = "{\"thresholdRatio\":0.4,\"retainRatio\":0.16,\"hotLedgerMaxTokens\":500,\"tier2After\":8,\"default_branch\":\"main\",\"version\":\"1.0.0\",\"language\":\"JS\",\"visibility\":\"private\",\"thresholdRatio\":0.4}";
    const all = extractValueFacts({ tool: "config", result: raw, evidenceSeq: 11 });
    t.eq(all.length, 8, "8 个不同的配置键（重复 thresholdRatio 只算一条）");
    t.eq(all.filter((fact) => fact.value === 0.4).length, 1, "重复键不得重复出事实");
    t.eq(all.every((fact) => fact.kind === "config"), true, "全是配置值");
    const capped = extractValueFacts({ tool: "config", result: raw, evidenceSeq: 11, maxFacts: 3 });
    t.eq(kindValuePairs(capped), [["config", 0.4], ["config", 0.16], ["config", 500]], "maxFacts 必须截断且保持文档顺序");
    const again = extractValueFacts({ tool: "config", result: raw, evidenceSeq: 11 });
    t.eq(again, all, "同样输入必须逐字段同样输出（确定性）");
  },

  "纯函数：冻结输入不抛、不改，args 原样不动，重复调用深相等"(t) {
    const input = deepFreeze({
      tool: "write",
      resultKind: "success",
      evidenceSeq: 42,
      args: { items: ["a", "b"], nested: { id: 9 } },
      result: "<path>/d/work/demo/f.mjs</path>\n<type>file</type>\n<content>\nCreated file\n</content>",
    });
    const first = extractValueFacts(input);
    const second = extractValueFacts(input);
    t.eq(first, second, "两次调用必须相同");
    t.eq(first.length, 1, "冻结输入仍正常抽取");
    t.eq(input.args, { items: ["a", "b"], nested: { id: 9 } }, "args 不得被读取/改写（数组实参不当返回值）");
    t.eq(Object.isFrozen(input), true, "夹具自身保持冻结（证明没有防御性拷贝依赖）");
  },

  "坏输入不抛：null / 非对象 / 空结果 / 坏 JSON / 超限结果一律空数组"(t) {
    for (const bad of [undefined, null, 42, "string", [], true]) {
      t.eq(extractValueFacts(bad), [], `input=${String(bad)} 必须空数组`);
    }
    t.eq(extractValueFacts({ evidenceSeq: 1 }), [], "没有 result");
    t.eq(extractValueFacts({ tool: "x", result: "{not json}", evidenceSeq: 1 }), [], "坏 JSON");
    t.eq(kindValuePairs(extractValueFacts({ tool: "x", result: "{\"id\":1", evidenceSeq: 1 })), [["id", 1]], "截断但成员完整 ⇒ 仍抽（与真机截断形态一致）");
    t.eq(extractValueFacts({ tool: "x", result: "{\"id\":", evidenceSeq: 1 }), [], "截断在值中间 ⇒ 空");
    const longJson = JSON.stringify({ id: 1, pad: "z".repeat(5000) });
    t.eq(extractValueFacts({ tool: "x", result: longJson, evidenceSeq: 1, maxResultChars: 1024 }), [], "超过 maxResultChars 不抽");
    t.eq(kindValuePairs(extractValueFacts({ tool: "x", result: longJson, evidenceSeq: 1 })), [["id", 1]], "未超限时同一结果可抽（证明上面是上限在起作用）");
    t.eq(extractValueFacts({ tool: "x", result: 12, evidenceSeq: 1 }), [], "非文本/非对象结果");
  },

  "isValueFact 拒绝缺字段/多字段/错类型/错 seq/未知 kind，接受真实产物"(t) {
    const good = runFixture("k2-api-json-id-private")[0];
    t.eq(isValueFact(good), true, "真实产物必须通过");
    const broken = [
      { ...good, extra: 1 },
      { ...good, kind: "unknown" },
      { ...good, kind: "file_path", value: 7 },
      { ...good, kind: "boolean", value: "false" },
      { ...good, evidenceSeq: 1.5 },
      { ...good, validAtSeq: -1 },
      { ...good, quote: "" },
      { ...good, quote: "a\u0000b" },
      { ...good, source: "write" },
      { ...good, value: undefined },
    ];
    for (const fact of broken) t.eq(isValueFact(fact), false, `必须拒绝 ${JSON.stringify(fact)}`);
    const { kind, ...missingKind } = good;
    t.eq(isValueFact(missingKind), false, "缺字段必须拒绝");
    t.eq(isValueFact(null), false, "null 必须拒绝");
  },

  "source 归一：工具名小写、非字母数字压成下划线、缺失走 unknown（不抛）"(t) {
    const base = { result: "{\"id\":1}", evidenceSeq: 1 };
    t.eq(extractValueFacts({ ...base, tool: "Write File!!" })[0].source, "tool:write_file", "非法字符压平");
    t.eq(extractValueFacts({ ...base, tool: "MCP__GitHub" })[0].source, "tool:mcp__github", "大写转小写、下划线保留");
    t.eq(extractValueFacts({ ...base })[0].source, "tool:unknown", "缺工具名 = unknown");
    t.eq(extractValueFacts({ ...base, tool: "   " })[0].source, "tool:unknown", "空白工具名 = unknown");
  },

  /* ═══════════════════ AX-21：「结果算不算可信」的判据（唯一来源） ═══════════════════ */

  "AX-21 githubReadShaped：只认 GitHub REST 端点的读形（GET/HEAD/缺省），写形与 MCP 一律不是"(t) {
    // ① 读形（无副作用：结果就是「读到的值」）
    t.eq(githubReadShaped("github", { path: "repos/o/r" }), true, "缺省 method ⇒ 读形（工具默认 GET）");
    t.eq(githubReadShaped("github", { path: "repos/o/r", method: "GET" }), true, "显式 GET");
    t.eq(githubReadShaped("GitHub", { path: "x", method: " head " }), true, "HEAD 也是读形；工具名/方法的大小写与空白不敏感");
    t.eq(githubReadShaped("github", null), true, "实参缺失 ⇒ 按缺省 GET（不抛）");
    t.eq(githubReadShaped("github", ["POST"]), true, "数组实参不是对象 ⇒ 按缺省 GET（不许把数组当 args 读）");

    // ② 写形（有副作用：回执不是「读到的值」，一条事实都不许产）
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) {
      t.eq(githubReadShaped("github", { path: "repos/o/r", method }), false, `显式 ${method} ⇒ 写形`);
    }
    t.eq(githubReadShaped("github", { path: "repos/o/r", body: { name: "x" } }), false, "缺省 method 但带 body ⇒ 不是读");
    t.eq(githubReadShaped("github", { path: "repos/o/r", confirm: true }), false, "confirm:true 是写方法的确认闸 ⇒ 不是读");
    t.eq(githubReadShaped("github", { path: "x", body: null, confirm: false }), true, "body:null / confirm:false 是「没带写形状」⇒ 仍是读");

    // ③ 不是 REST 端点：MCP 工具的方法在**名字**里，实参没有 method ⇒ 绝不按「缺省 GET」放行
    for (const name of ["mcp__github__create_pull_request", "github_create_issue", "github__create", "gh", "", "  "]) {
      t.eq(githubReadShaped(name, {}), false, `${JSON.stringify(name)} 不是 github REST 端点（一刀切会把写调用标成弱成功）`);
    }
  },

  "AX-21 resultKindForValueFacts：success/failure 直通、classify 的 weak 优先、github 读形补 weak、其余 unverified"(t) {
    t.eq(resultKindForValueFacts({ result: "success" }, "bash", {}), "success", "success 直通（不看工具名）");
    t.eq(resultKindForValueFacts({ result: "failure" }, "github", { method: "GET" }), "failure", "failure 优先于 github 读形（失败结果不许升格）");
    t.eq(resultKindForValueFacts({ result: "unverified", weak: "read" }, "read", {}), "read", "classify 的 weak 优先（只读工具）");
    t.eq(resultKindForValueFacts({ result: "unverified", weak: "shell" }, "bash", {}), "shell", "shell 弱成功原样");
    t.eq(resultKindForValueFacts({ result: "unverified" }, "github", { path: "repos/o/r" }), "weak", "github 读形 ⇒ weak（K-2 S2-Q3 的真实形状）");
    t.eq(resultKindForValueFacts({ result: "unverified" }, "github", { method: "POST", body: { a: 1 } }), "unverified", "github 写形 ⇒ 仍是 unverified（一条事实都不产）");
    t.eq(resultKindForValueFacts({ result: "unverified" }, "custom_tool", {}), "unverified", "其它 unverified 工具不升格");
    t.eq(resultKindForValueFacts(null, "custom_tool", {}), "unverified", "坏 verdict（null）不抛：非 GitHub 工具 ⇒ 无弱成功");
    t.eq(resultKindForValueFacts(undefined, "custom_tool", {}), "unverified", "坏 verdict（undefined）不抛");
    t.eq(resultKindForValueFacts(null, "github", { path: "repos/o/r" }), "weak", "坏 verdict 也不改变 GitHub 读形的放行（判据只看工具名+实参）");

    // ④ 端到端：同一份结果文本，读形产出 id/node_id/private，写形一条都不产
    const result = '{"id": 4242, "node_id": "R_demo4242", "private": false}';
    const readKind = resultKindForValueFacts({ result: "unverified" }, "github", { path: "repos/o/r" });
    const readFacts = extractValueFacts({ tool: "github", result, resultKind: readKind, evidenceSeq: 35 });
    const pairs = kindValuePairs(readFacts);
    t.eq(pairs.some(([kind, value]) => kind === "id" && value === 4242), true, "读形必须留下仓库 id（K2-O3）");
    t.eq(pairs.some(([kind, value]) => kind === "id" && value === "R_demo4242"), true, "node_id 也是 id 类事实（K2-N4 的答案片段）");
    t.eq(pairs.some(([kind, value]) => kind === "boolean" && value === false), true, "private=false 必须留下（false 不是「没有」）");
    const writeKind = resultKindForValueFacts({ result: "unverified" }, "github", { method: "POST", body: { name: "x" } });
    t.eq(extractValueFacts({ tool: "github", result, resultKind: writeKind, evidenceSeq: 36 }), [], "写形一条事实都不产（即使结果里带着 id）");
  },

  "AX-21 工具名归一：source 与 action 两侧同一口径（派生挂边靠它匹配，写错就恒不命中）"(t) {
    t.eq(normalizeToolName("Write File!!"), "write_file", "非字母数字压成下划线");
    t.eq(normalizeToolName("  MCP__GitHub  "), "mcp__github", "去首尾空白、转小写");
    t.eq(normalizeToolName(null), "", "null ⇒ 空串");
    t.eq(normalizeToolName("x".repeat(80)), "x".repeat(40), "截断 40（与 source 的口径一致）");

    t.eq(toolNameFromSource("tool:github"), "github", "`tool:` 前缀剥掉");
    t.eq(toolNameFromSource("write"), "", "不是 `tool:` 前缀 ⇒ 空串（不猜）");
    t.eq(toolNameFromSource(undefined), "", "undefined ⇒ 空串");

    t.eq(toolNameFromAction("github(path=repos/o/r)"), "github", "括号前的工具名");
    t.eq(toolNameFromAction("write"), "write", "没有括号 ⇒ 整串（actionSummary 的无参数形状）");
    t.eq(toolNameFromAction("   "), "", "空白 action ⇒ 空串");
    t.eq(toolNameFromAction(undefined), "", "undefined action ⇒ 空串");

    // 关键不变式：抽取器产的 source 必须能被边上的 action 还原成同一个名字，否则派生挂边恒不命中。
    const fact = extractValueFacts({ tool: "GitHub", result: '{"id":1}', evidenceSeq: 1 })[0];
    t.eq(toolNameFromSource(fact.source), toolNameFromAction("github(path=repos/o/r)"), "source 与 action 必须能对上");
    t.eq(toolNameFromSource(fact.source), "github", "而且对上的就是工具名本身");
  },

  /* ═══════════ AX-22：read 正文行值 / 顶层 JSON 数组（两个开关**默认关闭**） ═══════════
   *
   * 由来（AX-21 已证实，不是假设）：`evidence/k2-reader-expand-2026-11-07.json` 剩下的 4 题里，
   *   · K2-N2 / K2-N3 的答案长在 `read` 的**文件正文**里（`id: 'codearts',` / `'accio',`）；
   *   · K2-N5 / K2-N6 的答案长在 GitHub `contents` API 的**顶层 JSON 数组**里（`sha` / `size`）。
   * 两个形状过去都被契约挡住（read 正文只产 `file_path`；顶层数组「一律不抽」）。
   * 现在各配一个**默认 false** 的开关，且**只有读形**（`read` / `read_file` / GitHub REST GET）
   * 能打开 —— 默认关闭 ⇒ 线上 keeper / 旧语料一个字节都不变（下面第 6 条用例钉住）。
   */

  "AX-22 read 正文行值（正例）：读形 + allowReadContent ⇒ 每个短值行一条 value 事实（quote 逐字）"(t) {
    const facts = extractValueFacts({ tool: "read", result: READ_CONTENT_JS, resultKind: "read", evidenceSeq: 171 }, { allowReadContent: true });
    t.eq(kindValuePairs(facts), [
      ["file_path", "/d/work/demo/src/providers.js"],
      ["value", "id: 'codearts',"],
      ["value", "label: 'CodeArts (华为云)',"],
    ], "路径 + 两条带值的行；注释行与语句骨架行不是值");
    for (const fact of facts) {
      t.eq(isValueFact(fact), true, `六字段契约：${JSON.stringify(fact)}`);
      t.ok(READ_CONTENT_JS.includes(fact.quote), `quote 必须是结果原文的逐字连续子串：${JSON.stringify(fact.quote)}`);
    }
    const id = facts.find((fact) => fact.kind === "value");
    t.eq(id.value, id.quote, "value 与 quote 同源（行文本）");
    t.eq(id.evidenceSeq, 171, "evidenceSeq 原样（回证链路不补 0）");
    t.eq(id.source, "tool:read", "source 看得出是 read");
    t.eq(facts.some((fact) => fact.value === "/**" || fact.value === "*/"), false, "注释行不得成为值");
    t.eq(facts.some((fact) => fact.value.includes("export const PROVIDERS")), false, "无标量字面量的语句骨架不是值");
    // 反证：同一份正文在**旧契约**（不开开关）下一条行值都没有 —— 证明「行值可见」确实由开关带来。
    t.eq(kindValuePairs(extractValueFacts({ tool: "read", result: READ_CONTENT_JS, resultKind: "success", evidenceSeq: 171 })), [["file_path", "/d/work/demo/src/providers.js"]], "默认关闭 ⇒ 只有路径（旧契约逐字不变）");
  },

  "AX-22 read 正文行值（反例）：默认关闭 / 非读形工具 / 失败与未验证结果，都不产行值"(t) {
    const input = { tool: "read", result: READ_CONTENT_JS, evidenceSeq: 171 };
    t.eq(extractValueFacts({ ...input, resultKind: "read" }), [], "resultKind=read 且不开开关 ⇒ 旧信任闸仍拒绝（read 过去连路径都不产）");
    t.eq(extractValueFacts({ ...input, resultKind: "success" }).filter((fact) => fact.kind === "value"), [], "不开开关 ⇒ 一条行值都没有");
    // 非读形工具：即使调用方开了开关，也不产行值（工具形闸在抽取器里，防调用方乱传）。
    const write = extractValueFacts({ ...input, tool: "write", resultKind: "success" }, { allowReadContent: true });
    t.eq(kindValuePairs(write), [["file_path", "/d/work/demo/src/providers.js"]], "write 不是读形 ⇒ 只留路径，正文行值一条都不许产");
    const bash = extractValueFacts({ ...input, tool: "bash", resultKind: "success" }, { allowReadContent: true });
    t.eq(kindValuePairs(bash), [["file_path", "/d/work/demo/src/providers.js"]], "bash 也不是读形");
    // 结果信任闸优先：失败 / 无 weak 的未验证结果，开关打开也必须空。
    t.eq(extractValueFacts({ ...input, resultKind: "failure" }, { allowReadContent: true }), [], "failure ⇒ 空（错误结果不得进成功值事实）");
    t.eq(extractValueFacts({ ...input, resultKind: "unverified" }, { allowReadContent: true }), [], "unverified（无 weak）⇒ 空");
    t.eq(extractValueFacts({ ...input, resultKind: "success", isError: true }, { allowReadContent: true }), [], "isError 优先于一切开关");
  },

  "AX-22 顶层 JSON 数组（正例）：可信读形 + allowTopLevelArray ⇒ 标量元素与对象里的标量字段"(t) {
    const facts = extractValueFacts({ tool: "github", result: CONTENTS_ARRAY_JSON, resultKind: "weak", evidenceSeq: 129 }, { allowTopLevelArray: true });
    t.eq(kindValuePairs(facts), [
      ["value", "accio-adapter.d.ts"],
      ["value", "vendor/lib/accio-adapter.d.ts"],
      ["value", "c6f9d7a186c54e87f79007f6e08626dcb8701e8c"],
      ["value", "23738"],
      ["value", "file"],
      ["value", "plain-scalar"],
      ["value", "42"],
      ["value", "true"],
    ], "对象字段按文档顺序、标量元素字符串化（数字/布尔不丢）");
    for (const fact of facts) {
      t.eq(isValueFact(fact), true, `六字段契约：${JSON.stringify(fact)}`);
      t.ok(CONTENTS_ARRAY_JSON.includes(fact.quote), `quote 必须是原 JSON 片段：${JSON.stringify(fact.quote)}`);
    }
    const sha = facts.find((fact) => fact.value === "c6f9d7a186c54e87f79007f6e08626dcb8701e8c");
    t.eq(sha.quote, '"sha":"c6f9d7a186c54e87f79007f6e08626dcb8701e8c"', "quote 带键名（value 本身只看得出是个 sha）");
    t.eq(facts.some((fact) => String(fact.quote).includes("api.github.com")), false, "URL 字段占额度却不是短值 ⇒ 跳过");
    // 反证：同一份数组在默认关闭下**一条都没有**（契约第 3 条仍是默认行为）。
    t.eq(extractValueFacts({ tool: "github", result: CONTENTS_ARRAY_JSON, resultKind: "weak", evidenceSeq: 129 }), [], "默认关闭 ⇒ 顶层数组仍一律空");
  },

  "AX-22 顶层数组（反例）：非读形工具即使开开关也不按元素抽；args 数组仍绝不抽"(t) {
    for (const tool of ["todo_write", "write", "bash", "mcp__github__create_pull_request"]) {
      t.eq(
        extractValueFacts({ tool, result: CONTENTS_ARRAY_JSON, resultKind: "success", evidenceSeq: 5 }, { allowTopLevelArray: true, allowReadContent: true }),
        [],
        `${tool} 不是读形 ⇒ 数组一条都不许抽（契约第 3 条：数组实参不得当返回值）`,
      );
    }
    // github **写形**（method 在实参里）也不是读形：结果里带 id 也一样。
    t.eq(
      extractValueFacts(
        { tool: "github", result: CONTENTS_ARRAY_JSON, resultKind: "success", evidenceSeq: 6, args: { path: "repos/o/r", method: "POST", body: { a: 1 } } },
        { allowTopLevelArray: true },
      ),
      [],
      "github 写形（POST + body）⇒ 不是读形，数组不抽",
    );
    // args 里的数组/短值绝不成为事实（即使两个开关都开、结果是顶层数组）。
    const withArgs = extractValueFacts(
      { tool: "read", result: CONTENTS_ARRAY_JSON, resultKind: "success", evidenceSeq: 7, args: { ids: [1, 2, 3], id: 777, private: true } },
      { allowTopLevelArray: true, allowReadContent: true },
    );
    t.eq(withArgs.every((fact) => fact.source === "tool:read"), true, "source 只能是结果来源");
    t.eq(withArgs.some((fact) => fact.value === 777 || fact.value === "777"), false, "args 的 id 不许出现");
    t.eq(withArgs.some((fact) => fact.value === "1" || fact.value === "2"), false, "args 的数组元素不许出现");
  },

  "AX-22 有界：长正文 / 大数组只留 maxFacts 条，单值不超 maxValueChars，条数与结果规模无关"(t) {
    // ① 长正文：200 行带值，默认只留 maxFacts 条（8），且每条都短。
    const manyLines = Array.from({ length: 200 }, (_, index) => `${index + 1}:   id: 'provider-${index}',`).join("\n");
    const longRead = `<path>/d/work/demo/big.js</path>\n<type>file</type>\n<content>\n${manyLines}\n</content>`;
    const readFacts = extractValueFacts({ tool: "read", result: longRead, resultKind: "read", evidenceSeq: 900 }, { allowReadContent: true });
    t.eq(readFacts.length, VALUE_FACT_LIMITS.maxFacts, "条数由 maxFacts 封顶（1 条路径 + 7 条行值）");
    for (const fact of readFacts) {
      t.ok(String(fact.value).length <= VALUE_FACT_LIMITS.maxValueChars, `单值不得超过 maxValueChars：${fact.value.length}`);
      t.ok(fact.quote.length <= VALUE_FACT_LIMITS.maxQuoteChars, "quote 不得超过 maxQuoteChars");
    }
    const totalChars = readFacts.reduce((sum, fact) => sum + fact.quote.length, 0);
    t.ok(totalChars < longRead.length / 4, `事实总量必须远小于正文（${totalChars} / ${longRead.length}）`);
    // 超长行不是「短值」：整条丢弃，绝不截断（截断的值 = 假值）。
    const longLine = `1:   name: '${"x".repeat(VALUE_FACT_LIMITS.maxValueChars + 50)}',`;
    const dropped = extractValueFacts(
      { tool: "read", result: `<path>/d/work/demo/l.js</path>\n<type>file</type>\n<content>\n${longLine}\n</content>`, resultKind: "read", evidenceSeq: 901 },
      { allowReadContent: true },
    );
    t.eq(dropped.map((fact) => fact.kind), ["file_path"], "超过 maxValueChars 的行整条丢弃（不截断）");

    // ② 大数组：500 个元素也只留 maxFacts 条；maxFacts 可显式调小。
    const bigArray = JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ name: `n-${index}`, size: index })));
    t.ok(bigArray.length > 5000, "夹具必须真的很大");
    const arrayFacts = extractValueFacts({ tool: "github", result: bigArray, resultKind: "weak", evidenceSeq: 902 }, { allowTopLevelArray: true });
    t.eq(arrayFacts.length, VALUE_FACT_LIMITS.maxFacts, "大数组同样由 maxFacts 封顶");
    t.eq(extractValueFacts({ tool: "github", result: bigArray, resultKind: "weak", evidenceSeq: 902, maxFacts: 3 }, { allowTopLevelArray: true }).length, 3, "maxFacts 可调小");
  },

  "AX-22 旧 GOLD 零误杀：默认选项下现有夹具逐条不变（缺省 / {} / 两个 false 三者逐字相同）"(t) {
    for (const entry of FIXTURE.cases) {
      const byDefault = extractValueFacts(entry.input);
      t.eq(extractValueFacts(entry.input, {}), byDefault, `${entry.id}: 空 options 必须逐字相同`);
      t.eq(
        extractValueFacts(entry.input, { allowReadContent: false, allowTopLevelArray: false }),
        byDefault,
        `${entry.id}: 显式 false 必须逐字相同`,
      );
    }
    // 真实 K-2 形状的四个既有退化点（O1/O3/N4 的答案片段 + 读到的 JSON 配置）在默认下仍然抽得出。
    t.eq(kindValuePairs(extractValueFacts({ tool: "read", result: '<path>/d/work/demo/settings.json</path>\n<type>file</type>\n<content>\n1: {"thresholdRatio": 0.45, "factGuard": false}\n</content>', resultKind: "success", evidenceSeq: 7 })), [["file_path", "/d/work/demo/settings.json"], ["config", 0.45], ["boolean", false]], "read 到的 JSON 配置值仍按旧契约抽");
  },
};
