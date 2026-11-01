/**
 * install-revert.test.mjs —— 回滚路径的回归（2026-11-02，C88）
 *
 * `install` 会改 preset 文件；`revert` 是它唯一的退路。此前**没有任何测试引用 revert**
 * （`grep -rn revert test/*.mjs` 为空）—— 「装坏了能退回来」这句话没有证据。
 *
 * 钉住四件事：
 *   ① `backupFile` 真的复制内容并返回路径；
 *   ② 没有备份时 `revertPreset` 返回 false、**不改文件**、并明确告知；
 *   ③ 有备份时逐字还原；
 *   ④ 多个备份时取**最新**那份（按文件名倒序），不是最旧。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { backupFile, revertPreset } from "../scripts/install.mjs";

export const tests = {};

function tmpFile(content) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-revert-"));
  const file = nodePath.join(dir, "cordis.patch.yml");
  nodeFs.writeFileSync(file, content, "utf8");
  return { dir, file, cleanup: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
}

const silent = () => {};

tests["C88-1 backupFile 复制内容并返回备份路径"] = (t) => {
  const { file, cleanup } = tmpFile("original: true\n");
  try {
    const bak = backupFile(file, 1234);
    t.eq(nodeFs.existsSync(bak), true, "备份文件必须存在");
    t.eq(nodeFs.readFileSync(bak, "utf8"), "original: true\n", "备份内容必须与原文一致");
    t.includes(bak, "bak-before-gokifu-1234", "备份名要带时间戳（可追溯）");
  } finally {
    cleanup();
  }
};

tests["C88-2 没有备份：返回 false、明确告知、**绝不改文件**"] = (t) => {
  const { file, cleanup } = tmpFile("keep-me\n");
  try {
    const lines = [];
    const ok = revertPreset(file, (m) => lines.push(m));
    t.eq(ok, false, "没有备份必须返回 false");
    t.eq(nodeFs.readFileSync(file, "utf8"), "keep-me\n", "没有备份时不许改动文件");
    t.eq(lines.some((l) => l.includes("没有备份")), true, `要明确告知用户没有备份：${JSON.stringify(lines)}`);
  } finally {
    cleanup();
  }
};

tests["C88-3 有备份：逐字还原（装坏 → 回滚 = 原文）"] = (t) => {
  const original = "plugins:\n  - id: compaction-basic\n";
  const { file, cleanup } = tmpFile(original);
  try {
    backupFile(file, 1);
    nodeFs.writeFileSync(file, "plugins:\n  - id: dsh-gokifu-compact\n", "utf8"); // 模拟 install 改坏/改对
    const ok = revertPreset(file, silent);
    t.eq(ok, true, "有备份必须还原成功");
    t.eq(nodeFs.readFileSync(file, "utf8"), original, "回滚后必须与安装前逐字一致");
  } finally {
    cleanup();
  }
};

tests["C88-4 多个备份：必须取最新（按文件名倒序），不是最旧"] = (t) => {
  const { file, cleanup } = tmpFile("v0\n");
  try {
    backupFile(file, 100); // v0 的备份
    nodeFs.writeFileSync(file, "v1\n", "utf8");
    backupFile(file, 200); // v1 的备份
    nodeFs.writeFileSync(file, "v2-broken\n", "utf8");
    revertPreset(file, silent);
    t.eq(nodeFs.readFileSync(file, "utf8"), "v1\n", "必须回到最近一次安装前的状态（v1），不是最旧的 v0");
  } finally {
    cleanup();
  }
};

tests["C88-5 备份名按**数字**排序：999 与 1000 之间必须选 1000（字典序会选错）"] = (t) => {
  const NL = String.fromCharCode(10);
  const { file, cleanup } = tmpFile("v0" + NL);
  try {
    backupFile(file, 999);
    nodeFs.writeFileSync(file, "v999" + NL, "utf8");
    backupFile(file, 1000);
    nodeFs.writeFileSync(file, "v1000-broken" + NL, "utf8");
    revertPreset(file, silent);
    t.eq(nodeFs.readFileSync(file, "utf8"), "v999" + NL, "必须还原到 1000 那次安装前的状态（v999），而不是 999 那份更旧的");
  } finally {
    cleanup();
  }
};
