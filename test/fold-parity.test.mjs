/**
 * fold-parity.test.mjs —— 「脚本」与「引擎」两条离线补折路径的**参数口径**必须一致（C560）
 *
 * 由来：真机连续踩到两次「一条路改了、另一条没改」——
 *   · C559：脚本关了思考，引擎没关（同一输入正文 4,221 vs 715 字符）；
 *   · C560：引擎按输入自适应预算，脚本固定 8192。
 * 这类分叉不会让测试变红，只会让"脚本验证过了"变成一句空话。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { foldBudgetFor } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");

tests["C560 预算算法是共用的（脚本不再固定 8192）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  t.includes(script, "foldBudgetFor(prompt.length", "脚本必须用共用算法");
  t.eq(script.includes("maxTokens: maxTokensArg"), true, "调用点仍然用它");
  // 同一算法在两端得到同一个数
  t.eq(foldBudgetFor(40_000, 8192), 10_000, "40k 字符 ⇒ 10k 预算");
  t.eq(foldBudgetFor(4_000, 8192), 8192, "小输入不低于配置值");
  t.eq(foldBudgetFor(200_000, 8192), 16_384, "上限 16384");
};

tests["C560 两条路径都必须关思考（C559 的教训固化）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  const engine = read("src/engine.mjs");
  t.includes(script, 'thinking: { type: "disabled" }', "脚本关思考");
  const at = engine.indexOf("async #offlineCloseoutFold");
  t.includes(engine.slice(at, at + 9000), 'thinking: { type: "disabled" }', "引擎关思考");
};

tests["C560 两条路径都从 agent-default-model 取模型（不自选）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  const engine = read("src/engine.mjs");
  t.includes(script, "readDefaultModel(", "脚本读默认模型");
  const at = engine.indexOf("async #offlineCloseoutFold");
  t.includes(engine.slice(at, at + 9000), "readDefaultModel(", "引擎读默认模型");
};

tests["C574 补账用独立 user_id（官方：user_id 做 KVCache 隔离）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  t.includes(script, 'user_id: "gokifu-backfill"', "补账必须与交互会话分开占缓存");
  t.includes(script, "KVCache 隔离", "注释要写明官方出处（免得被当成无用参数删掉）");
};

tests["C576 正文被推理挤掉时要补预算重试（不是有文本就算成功）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  t.includes(script, 'result.finish === "length" && Number(result.usage?.reasoning_tokens ?? 0) > 0', "要按实测推理量判截断");
  t.includes(script, "正文被推理挤掉", "重试要留痕");
  t.includes(script, "32_768", "补预算要有上限");
  t.includes(script, 'reasoning_effort: "none"', "关闭思考（none 才是开关）");
};

tests["C578 两条路都要传 reasoning_effort: none（none 才是关闭开关）"] = (t) => {
  const script = read("scripts/archive-fold.mjs");
  const engine = read("src/engine.mjs");
  t.includes(script, 'reasoning_effort: "none"', "脚本要关思考");
  const at = engine.indexOf("async #offlineCloseoutFold");
  t.includes(engine.slice(at, at + 9000), 'reasoning_effort: "none"', "引擎也要关思考");
  // ★ low/high/max 都是"开启"，别再被当成强度旋钮
  t.eq(script.includes('reasoning_effort: "low"'), false, "low 是开启思考，不是降低强度");
  t.includes(script, "none 关闭思考模式", "注释要写明官方原话（免得又被改回 low）");
};
