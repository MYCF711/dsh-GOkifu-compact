/**
 * test-counts.test.mjs —— 「有用例被删/被覆盖」必须报警（C325）
 *
 * 事故（2026-11-02）：用 `cat >` 追加用例，把 `check-maintenance.test.mjs` 原有的 4 条覆盖掉，
 * 全量从 1051 掉到 1049 —— **没有任何东西报警**，因为少了的用例本来就不会再跑。
 *
 * 这里钉住两件事：
 *   ① 当前用例数相对基线**不许收缩**（新增文件要先更新基线，是一次显式动作）；
 *   ② 守卫本身要能认出收缩（用假数据自检，防"永远绿"）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { collectCounts, compareCounts } from "../scripts/test-counts.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const BASELINE = nodePath.join(HERE, "counts-baseline.json");

export const tests = {};

tests["C325 用例数不许悄悄缩（当前 vs 基线）"] = (t) => {
  t.eq(nodeFs.existsSync(BASELINE), true, "必须有 test/counts-baseline.json（node scripts/test-counts.mjs --write 生成）");
  if (!nodeFs.existsSync(BASELINE)) return;
  const baseline = JSON.parse(nodeFs.readFileSync(BASELINE, "utf8"));
  const current = collectCounts(HERE);
  const { shrunk, removed } = compareCounts(current, baseline.files ?? {});
  t.eq(shrunk, [], `这些文件的用例变少了（被删/被覆盖？）：${JSON.stringify(shrunk)}`);
  t.eq(removed, [], `这些测试文件整份不见了：${JSON.stringify(removed)}`);
};

tests["C325 守卫自检：收缩必须被认出来"] = (t) => {
  const r = compareCounts({ "a.test.mjs": 3, "b.test.mjs": 5 }, { "a.test.mjs": 4, "b.test.mjs": 5, "c.test.mjs": 2 });
  t.eq(r.shrunk, [{ file: "a.test.mjs", was: 4, now: 3 }], "少一条要报出来");
  t.eq(r.removed, ["c.test.mjs"], "整份消失也要报");
  t.eq(r.grown, [], "没长就不报增长");
  const g = compareCounts({ "a.test.mjs": 9 }, { "a.test.mjs": 4 });
  t.eq(g.grown, [{ file: "a.test.mjs", was: 4, now: 9 }], "变多要报增长（提示更新基线）");
  t.eq(g.shrunk, [], "变多不算收缩");
};
