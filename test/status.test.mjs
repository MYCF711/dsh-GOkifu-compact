/**
 * status.test.mjs —— 「一条命令看完现状」的拼装逻辑（C422）
 *
 * 它不重算任何东西，只编排现成脚本；所以这里钉的是**渲染**与**缺省行为**。
 */
import { renderStatus } from "../scripts/status.mjs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

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

tests["C425 关键文档不得被截断（进度页曾因异常写入变成 0 字节并被提交）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const root = nodePath.join(here, "..");
  // 下限只防"被清空/被截断"，不是排版约束：进度页长期在 200KB 量级
  const floors = { "docs/knowledge/进度.md": 100_000, "CHANGELOG.md": 100_000, "HANDOFF.md": 10_000 };
  for (const [rel, min] of Object.entries(floors)) {
    const size = nodeFs.statSync(nodePath.join(root, rel)).size;
    t.eq(size >= min, true, `${rel} 只有 ${size} 字节（下限 ${min}）—— 可能被截断/清空，先 git checkout 恢复`);
  }
};

tests["C427 用户会用的脚本必须在发布物里（pack 复验过，但要有守卫）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const root = nodePath.join(here, "..");
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "package.json"), "utf8"));
  t.eq(Array.isArray(pkg.files), true, "package.json 必须有 files");
  // 这些目录/文件是用户真正会碰的：脚本、lib、docs、evidence
  for (const need of ["scripts", "lib", "docs"]) {
    t.eq(pkg.files.includes(need), true, `files 必须包含 ${need}（否则发布物里没有它）`);
  }
  // 逐个点名"用户会直接跑"的脚本，防止它们被改名/漏掉
  for (const rel of ["scripts/status.mjs", "scripts/backfill-plan.mjs", "scripts/backfill-one.mjs", "scripts/accept-after-restart.mjs"]) {
    t.eq(nodeFs.existsSync(nodePath.join(root, rel)), true, `${rel} 必须存在（用户会直接跑）`);
  }
};

tests["C431 status --fast 跳过门禁（快看一眼 vs 交付前验一遍，两种用法）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "status.mjs"), "utf8");
  t.includes(src, 'argv.includes("--fast")', "必须支持 --fast（C431）");
  t.includes(src, "未跑（--fast）", "--fast 时门禁那行要明说未跑（不能留空或假装通过）");
  t.includes(src, "!fast && gateOut", "--fast 时不许把测试标成「门禁内全绿」");
};

tests["C447 循环形状行：有数据就给数字，没有就明说未采集（仪器不许静默）"] = (t) => {
  const withData = renderStatus({
    loop: { sessions: 37, loopSessions: 9, loopRate: 9 / 37, longest: 6, pressureFolds: 86, pressureAfterLoop: 5, pressureBroke: 5, sigEdges: 0 },
  });
  const line = withData.find(([k]) => k === "循环形状")[1];
  t.includes(line, "9/37", "必须给分子/分母（没有分母的数字没法判断严重程度）");
  t.includes(line, "24.3%", "比例要算出来");
  t.includes(line, "最长 6", "最长连击");
  t.includes(line, "5/5", "折叠前有循环形状的次数 / 折完变短的次数");
  t.includes(line, "老棋谱无指纹", "sig 覆盖为 0 时必须标注口径偏宽（否则会当成生产口径读）");

  const clean = renderStatus({
    loop: { sessions: 37, loopSessions: 0, loopRate: 0, longest: 0, pressureFolds: 0, pressureAfterLoop: 0, pressureBroke: 0, sigEdges: 100 },
  });
  t.eq(clean.find(([k]) => k === "循环形状")[1].includes("老棋谱无指纹"), false, "全部带指纹时不许挂口径警告");

  t.eq(renderStatus({}).find(([k]) => k === "循环形状")[1], "未采集", "没数据时明说未采集，不许空着");
};

tests["C454 动作开销行：给「累计最贵的工具 + 单次最贵」，没数据说未采集"] = (t) => {
  const rows = renderStatus({
    actionCost: { topByTotal: "bash", topTotal: 2_157_749, topCount: 2986, topMedian: 576, topMedianMax: 6708 },
  });
  const line = rows.find(([k]) => k === "动作开销")[1];
  t.includes(line, "bash", "要点名是哪个工具");
  t.includes(line, "2,158k tok", "累计值（以 k 为单位，避免 7 位数字挤爆一行）");
  t.includes(line, "2986 次", "次数 —— 累计高到底是单次贵还是次数多，必须能分开看");
  t.includes(line, "576", "单次中位");
  t.includes(line, "6708", "单次最贵");
  t.eq(renderStatus({}).find(([k]) => k === "动作开销")[1], "未采集", "没数据说未采集，不许空着");
};

tests["C463 折叠回本行：中位回本次数 + 成本 + 快照年龄；没数据说未采集"] = (t) => {
  const rows = renderStatus({ economics: { folds: 73, costUsd: 2.73, paybackMedian: 5.2, ageMinutes: 7, minSteps: 131 } });
  const line = rows.find(([k]) => k === "折叠回本")[1];
  t.includes(line, "6 次请求", "上取整（5.2 ⇒ 6，宁可说多一次）");
  t.includes(line, "73 次", "折叠次数");
  t.includes(line, "2.73", "成本");
  t.includes(line, "7 分钟前", "快照年龄必须写出来 —— 否则看起来像实时数");
  // 缺 usage/遮蔽量时不许编数字
  const noPayback = renderStatus({ economics: { folds: 3, costUsd: 0, paybackMedian: null, ageMinutes: 1 } });
  t.includes(noPayback.find(([k]) => k === "折叠回本")[1], "算不出", "缺数据要说算不出");
  t.eq(renderStatus({}).find(([k]) => k === "折叠回本")[1], "未采集", "完全没快照时说未采集");
};

tests["C468 折叠失败 / 归档收尾两行：转述 doctor 的正文，未采集要说出来"] = (t) => {
  const rows = renderStatus({
    doctor: { bad: 0, warn: 1, foldFailures: { status: "warn", detail: "1 个会话记着失败：upstream-routing=1 · 最近一次 …" }, closeout: { status: "warn", detail: "24 个会话已归档却没有 closeout" } },
  });
  const failLine = rows.find(([k]) => k === "折叠失败")[1];
  t.includes(failLine, "upstream-routing", "分类要透传（这正是 C467 的价值）");
  t.includes(failLine, "⚠", "warn 状态要能一眼看出");
  const closeLine = rows.find(([k]) => k === "归档收尾")[1];
  t.includes(closeLine, "24 个", "数字要透传");
  // 没有 doctor 数据时不许空着
  const empty = renderStatus({});
  t.eq(empty.find(([k]) => k === "折叠失败")[1], "未采集（重启后跑过折叠才有）", "缺数据要说未采集");
  t.eq(empty.find(([k]) => k === "归档收尾")[1], "未采集", "归档同理");
};

tests["C549 折叠快照过期要明说（超过 1 天就别当现状）"] = async (t) => {
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "status.mjs"), "utf8");
  t.includes(src, "已过期，别当现状看", "过期要有一句明说");
  t.includes(src, "1440", "阈值写死在源码里（1 天）");
};

tests["C550 自动补账行要能区分新代码（新字段在不在）"] = async (t) => {
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "status.mjs"), "utf8");
  t.includes(src, "newFields", "要数新字段");
  t.includes(src, "sectionsMissing", "判据用 C528 写的字段");
  t.includes(src, "跑的还是旧代码", "没有新字段时要直说");
};

tests["C585 状态页要给「近 1 小时」速率（24h 总量看不出快慢）"] = (t) => {
  const row = renderStatus({ autoBackfill: { enabled: true, lastAt: Date.now() - 60_000, last24h: 53, last1h: 9, newFields: 3 } })
    .find((r) => r[0] === "自动补账");
  t.includes(row[1], "近 1h 9 段", "必须显示一小时速率");
  const noHour = renderStatus({ autoBackfill: { enabled: true, lastAt: Date.now(), last24h: 3, newFields: 1 } })
    .find((r) => r[0] === "自动补账");
  t.eq(noHour[1].includes("近 1h"), false, "没这个字段时不显示（老数据兼容）");
};
