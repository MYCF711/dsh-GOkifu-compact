/**
 * audit-field-reads.test.mjs —— 「读了但没人写」的字段探测器本身要有判据（C281）
 *
 * 由来：C280 的 doctor 一直在读一个从不存在的字段，却永远报"正常"。
 * 这条工具就是为了批量找同类。但它自己也不能假绿：读不出幽灵 ⇒ 这条测试必须红。
 */
import { auditOwnedFields, HOST_PASSTHROUGH, OWNED_ROOTS } from "../scripts/audit-field-reads.mjs";

export const tests = {};

tests["C281 真幽灵必须被抓（读了 .quality.ghostField 但全仓库没人写）"] = (t) => {
  const files = [
    ["scripts/reader.mjs", "const x = mark.quality.ghostField;"],
  ];
  const { ghosts } = auditOwnedFields(files);
  t.eq(ghosts.length, 1, `必须抓到一个幽灵：${JSON.stringify(ghosts)}`);
  t.eq(ghosts[0].field, "ghostField", "字段名要对");
  t.includes(ghosts[0].files.join(","), "scripts/reader.mjs", "要指出来源文件");
};

tests["C281 三种「其实写了」的写法都不许误报（显式键 / 简写 / 宿主透传）"] = (t) => {
  // ① 显式键
  const explicit = auditOwnedFields([
    ["a.mjs", "const q = { okField: 1 };"],
    ["b.mjs", "x.quality.okField;"],
  ]);
  t.eq(explicit.ghosts.length, 0, `显式键不许误报：${JSON.stringify(explicit.ghosts)}`);

  // ② 对象简写 `{ at, eventsSinceLastFold, folds }`
  const shorthand = auditOwnedFields([
    ["a.mjs", "g.closeout = { at: 1, okShorthand, folds: 0 };"],
    ["b.mjs", "g.closeout.okShorthand;"],
  ]);
  t.eq(shorthand.ghosts.length, 0, `简写写法不许误报：${JSON.stringify(shorthand.ghosts)}`);

  // ③ 宿主透传（白名单里的字段本仓库只读不写）
  const passthrough = auditOwnedFields([
    ["a.mjs", "const n = mark.usage.cacheReadTokens;"],
  ]);
  t.eq(passthrough.ghosts.length, 0, "宿主透传字段不许误报");
  t.eq(Object.keys(HOST_PASSTHROUGH).includes("cacheReadTokens"), true, "白名单必须写明 cacheReadTokens 的来源");
};

tests["C281 只扫我们自己的结构（方法调用不许进结果）"] = (t) => {
  const files = [["a.mjs", "const s = list.sort(); const u = name.startsWith('x');"]];
  const { ghosts, reads } = auditOwnedFields(files);
  t.eq(ghosts.length, 0, "sort/startsWith 不该被当成自有字段");
  t.eq(reads.length, 0, `只扫自有结构，不该读到任何字段：${JSON.stringify(reads)}`);
  t.eq(OWNED_ROOTS.includes("quality"), true, "quality 必须在扫描范围里");
};
