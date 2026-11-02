/**
 * status.test.mjs —— 「一条命令看完现状」的拼装逻辑（C422）
 *
 * 它不重算任何东西，只编排现成脚本；所以这里钉的是**渲染**与**缺省行为**。
 */
import { renderStatus } from "../scripts/status.mjs";

export const tests = {};

tests["C422 renderStatus：六行齐全，缺数据时明说「未采集」而不是空着"] = (t) => {
  const rows = renderStatus({});
  const keys = rows.map(([k]) => k);
  for (const want of ["门禁", "全量测试", "doctor", "面板", "补账", "真机基准"]) {
    t.eq(keys.includes(want), true, `缺行：${want}`);
  }
  t.eq(rows.every(([, v]) => v !== "" && v !== undefined), true, "任何一行都不许是空串");
  t.eq(rows.find(([k]) => k === "补账")[1], "未采集", "没数据时明说未采集");
};

tests["C422 renderStatus：有数据时格式正确（含 gate 内测试的负值约定）"] = (t) => {
  const rows = renderStatus({
    gate: "✅ 门禁 6/6 通过",
    tests: { passed: -1, failed: 0 },
    doctor: { bad: 0, warn: 11 },
    panel: { ok: true, detail: "认识 update / backfill" },
    debt: { due: 48, costUsd: 1.63, clicks: 3 },
    bench: { hitRate: 0.951, totalCost: 115.08 },
  });
  const get = (k) => rows.find(([x]) => x === k)[1];
  t.includes(get("全量测试"), "未重跑", "负值 = 门禁内已跑，不许显示 -1 passed");
  t.eq(get("doctor"), "错误 0 / 警告 11", "doctor 格式");
  t.eq(get("补账"), "48 个欠账 · $1.63 · 约 3 次点击", "补账格式");
  t.eq(get("真机基准"), "命中 95.1% · 全量 $115.08", "基准格式");
};

tests["C423 status 必须可发现：package.json 有脚本，HANDOFF/README 都指向它"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const root = nodePath.join(here, "..");
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "package.json"), "utf8"));
  t.eq(pkg.scripts?.status, "node scripts/status.mjs", "package.json 必须有 status 脚本");
  for (const f of ["HANDOFF.md", "README.md"]) {
    const text = nodeFs.readFileSync(nodePath.join(root, f), "utf8");
    t.includes(text, "npm run status", `${f} 必须指向 npm run status（工具必须可发现）`);
  }
};
