/**
 * make-presets-override.test.mjs —— 生成器的**安全性与确定性**（2026-11-02，C84）
 *
 * 这个脚本生成的是 `cordis.patch.yml`（把四个官方 preset 的压缩引擎换成棋谱压缩）——
 * 它写的是**安装产物**，写错了整个插件就不接管。但此前它**没有任何测试**：
 *
 *   · dry-run 是否真的不写盘（默认行为必须是安全的）；
 *   · 自检（`validateBundlePatch`）是否通过；
 *   · 同样输入是否产出同样结果（确定性 —— 不然每次生成都会抖）；
 *   · 仓库里的 `cordis.patch.yml` 是否覆盖四个官方 preset 且**不再引用** compaction-basic。
 *
 * 不测 `--write`：它会改仓库文件，测它等于在测试里做发布动作。
 */

import { execFileSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "make-presets-override.mjs");
const PATCH = nodePath.join(REPO, "cordis.patch.yml");

export const tests = {};

const sha = (file) => nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex");

function runDry() {
  return execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

tests["C84-1 dry-run 必须 0 退出、自检通过、且**不写**仓库里的 cordis.patch.yml"] = (t) => {
  const before = sha(PATCH);
  const out = runDry();
  const after = sha(PATCH);
  t.eq(before, after, "dry-run 不许改 cordis.patch.yml");
  t.includes(out, "自检通过", `自检必须通过：\n${out.slice(-400)}`);
  t.includes(out, "dry-run", "必须明确告诉用户「没写盘」");
  // ★ C512：判据改成**前后差集**。原来直接断言"一个都没有"——
  //   可仓库里可能早就躺着一次**真实安装**留下的备份（那是历史，不是这次 dry-run 造成的），
  //   于是这条测试会在"有没有历史备份"上随机红绿。dry-run 的契约是"**这次**没写"。
  const backupsBefore = new Set(nodeFs.readdirSync(REPO).filter((f) => f.startsWith("cordis.patch.yml.bak-")));
  runDry();
  const backupsAfter = nodeFs.readdirSync(REPO).filter((f) => f.startsWith("cordis.patch.yml.bak-"));
  const added = backupsAfter.filter((f) => !backupsBefore.has(f));
  t.eq(added, [], `dry-run 不许留下备份文件（本次新增 ${added.join(",")}）`);
};

tests["C84-2 确定性：同样输入两次输出必须逐字相同（发布日期不抖）"] = (t) => {
  const a = runDry();
  const b = runDry();
  t.eq(a, b, "两次 dry-run 的输出必须一致（含 4 个 preset 的行数/引擎行/!!js 统计）");
};

tests["C84-3 仓库里的 cordis.patch.yml 覆盖四个官方 preset，且不再引用 compaction-basic"] = (t) => {
  const patch = nodeFs.readFileSync(PATCH, "utf8");
  for (const id of ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]) {
    t.includes(patch, id, `patch 必须覆盖 ${id}`);
  }
  t.eq(/- id: compaction-basic/.test(patch), false, "patch 里不许再有 compaction-basic 行（否则引擎没被换掉）");
  t.includes(patch, "dsh-gokifu-compact", "patch 必须把引擎指向本插件");
};
