/**
 * install-ui-step.test.mjs —— 安装第①步（profile 里挂 UI host 行）的回归（2026-11-02，C89）
 *
 * `patchProfileForUi` 此前**零测试引用**。它是「设置页 / `/gokifu/api` 到底有没有」的那一步：
 * 这一步坏了，压缩引擎照跑，但整个详情页消失 —— 用户会以为插件没装好。
 *
 * ★ 全部在 `os.tmpdir()` 的临时目录里做：**绝不碰 live profile**
 *   （AGENTS 铁律 3：会话中直接写 `home\profiles\*\cordis.patch.yml` 会触发整树热重载）。
 *
 * 钉住：没有文件时不乱写 / dry-run 不落盘 / 真跑要备份且内容正确 / 幂等 /
 *      `removeManualUiRow` 能删干净 / 结构不认识时**拒绝改**。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { findManualUiRow, patchProfileForUi, removeManualUiRow } from "../scripts/install.mjs";

export const tests = {};

const NL = String.fromCharCode(10);

function tmpProfile(content) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-ui-step-"));
  if (content !== null) nodeFs.writeFileSync(nodePath.join(dir, "cordis.patch.yml"), content, "utf8");
  return { dir, file: nodePath.join(dir, "cordis.patch.yml"), cleanup: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
}

const silent = () => {};

tests["C89-1 没有 profile cordis.patch.yml ⇒ 不改、不乱建文件"] = (t) => {
  const { dir, file, cleanup } = tmpProfile(null);
  try {
    const r = patchProfileForUi(dir, silent, false);
    t.eq(r.changed, false, "没有目标文件时不许声称改了");
    t.eq(nodeFs.existsSync(file), false, "不许凭空创建 profile 的 patch 文件");
  } finally {
    cleanup();
  }
};

tests["C89-2 dry-run 只报告、不写盘也不留备份"] = (t) => {
  const original = "plugins: []" + NL;
  const { dir, file, cleanup } = tmpProfile(original);
  try {
    const r = patchProfileForUi(dir, silent, true);
    t.eq(r.changed, true, "dry-run 应报告「会加」");
    t.eq(r.dryRun, true, "要标明是 dry-run");
    t.eq(nodeFs.readFileSync(file, "utf8"), original, "dry-run 不许改文件");
    const backups = nodeFs.readdirSync(dir).filter((f) => f.includes("bak-before-gokifu-ui"));
    t.eq(backups.length, 0, `dry-run 不许留备份：${backups.join(",")}`);
  } finally {
    cleanup();
  }
};

tests["C89-3 真跑：写入 gokifu-ui 块 + 备份原文；再跑一次必须幂等"] = (t) => {
  const original = "plugins: []" + NL;
  const { dir, file, cleanup } = tmpProfile(original);
  try {
    const r = patchProfileForUi(dir, silent, false);
    t.eq(r.changed, true, "首次必须写入");
    const text = nodeFs.readFileSync(file, "utf8");
    t.includes(text, "- id: gokifu-ui", "必须插入 gokifu-ui 行");
    t.includes(text, "name: 'dsh-gokifu-compact'", "必须指向本包");
    t.eq(nodeFs.existsSync(r.backup), true, "必须留备份");
    t.eq(nodeFs.readFileSync(r.backup, "utf8"), original, "备份必须是改动前的原文");

    const again = patchProfileForUi(dir, silent, false);
    t.eq(again.changed, false, "第二次必须幂等（不重复插入）");
    t.eq(nodeFs.readFileSync(file, "utf8"), text, "幂等调用不许改动内容");
  } finally {
    cleanup();
  }
};

tests["C89-4 removeManualUiRow：删干净并留备份；没有手工行时明确返回 false"] = (t) => {
  const { dir, file, cleanup } = tmpProfile("plugins: []" + NL);
  try {
    patchProfileForUi(dir, silent, false);
    const added = nodeFs.readFileSync(file, "utf8");
    const removed = removeManualUiRow(dir, silent, false);
    t.eq(removed.changed, true, "有手工行时必须能删");
    const after = nodeFs.readFileSync(file, "utf8");
    t.eq(after.includes("gokifu-ui"), false, `删除后不许还残留：${after}`);
    t.eq(nodeFs.existsSync(removed.backup), true, "删除必须留备份");
    t.eq(nodeFs.readFileSync(removed.backup, "utf8"), added, "备份必须是删除前的原文");

    const none = removeManualUiRow(dir, silent, false);
    t.eq(none.changed, false, "没有手工行时必须返回 false");
  } finally {
    cleanup();
  }
};

tests["C89-5 结构不认识：findManualUiRow 返回 unsupported，removeManualUiRow 拒绝改文件"] = (t) => {
  // 有 gokifu-ui 行，但**没有** `- insert:` 父行
  const weird = "plugins:" + NL + "  - id: gokifu-ui" + NL + "    name: x" + NL;
  const found = findManualUiRow(weird);
  t.eq(found !== null, true, "必须找到这一行");
  t.eq(found.unsupported === true, true, "找不到父 insert 块时必须标 unsupported");
  const { dir, file, cleanup } = tmpProfile(weird);
  try {
    const r = removeManualUiRow(dir, silent, false);
    t.eq(r.changed, false, "结构不认识时不许改");
    t.includes(r.reason, "拒绝改", "理由要说清「拒绝改」");
    t.eq(nodeFs.readFileSync(file, "utf8"), weird, "拒绝改时文件必须原样");
  } finally {
    cleanup();
  }
};
