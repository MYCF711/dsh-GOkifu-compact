/**
 * doctor-switch.test.mjs —— doctor / status 必须报告实际生效的自动归档补折开关。
 *
 * 引擎 #startAutoBackfill 只认 autoArchiveBackfill === true；旧 autoBackfill 不在
 * RESOLVE_ORDER，单独写 true 也不能打开后台补折。三种配置都跑真实 CLI + 隔离 home。
 */
import { spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const LEGACY_NOTE = "旧 autoBackfill 不在 RESOLVE_ORDER，写了也不生效";

export const tests = {};

function makeHome(patchText = null) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-doctor-switch-"));
  if (patchText !== null) {
    const profile = nodePath.join(home, "profiles", "desktop");
    nodeFs.mkdirSync(profile, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(profile, "cordis.patch.yml"), patchText, "utf8");
  }
  return home;
}

function run(script, args, home) {
  const result = spawnSync(process.execPath, [nodePath.join(REPO, "scripts", script), ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  // doctor 有警告时退出 1，但 stdout 仍是完整 JSON；其它失败（没有 JSON）必须真红。
  return JSON.parse(result.stdout);
}

function doctorRow(home) {
  const payload = run("doctor.mjs", ["--json"], home);
  const row = payload.checks.find((check) => check.name === "自动补账");
  if (!row) throw new Error("doctor 缺少「自动补账」检查");
  return row;
}

function statusRow(home) {
  const payload = run("status.mjs", ["--fast", "--no-panel", "--json"], home);
  const row = payload.rows.find(([name]) => name === "自动补账");
  if (!row) throw new Error("status 缺少「自动补账」行");
  return { enabled: payload.autoBackfill?.enabled, detail: row[1] };
}

function patch(lines) {
  return `- insert:\n    - id: gokifu-compact\n      config:\n${lines.map((line) => `        ${line}\n`).join("")}`;
}

function verify(t, { label, home, enabled }) {
  try {
    const doctor = doctorRow(home);
    const status = statusRow(home);
    console.log(`[${label}] doctor: ${doctor.detail}`);
    console.log(`[${label}] status: ${status.detail}`);
    t.eq(status.enabled, enabled, `${label}：status.enabled 必须是实际生效值`);
    t.eq(doctor.detail.includes("已关闭"), !enabled, `${label}：doctor 开/关文案必须正确`);
    t.eq(status.detail.includes("已关闭"), !enabled, `${label}：status 开/关文案必须正确`);
    t.eq(doctor.detail.includes("开（autoArchiveBackfill: true）"), enabled, `${label}：doctor 显式开只能来自新键 true`);
    t.eq(status.detail.includes("开（autoArchiveBackfill: true）"), enabled, `${label}：status 显式开只能来自新键 true`);
    t.includes(doctor.detail, LEGACY_NOTE, `${label}：doctor 必须说明旧键不生效`);
    t.includes(status.detail, LEGACY_NOTE, `${label}：status 必须说明旧键不生效`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

tests["T72 默认新键 false：doctor / status 都报关"] = (t) => {
  verify(t, { label: "默认（新键 false）", home: makeHome(), enabled: false });
};

tests["T72 显式打开新键：doctor / status 都报开，旧键 false 不覆盖新键"] = (t) => {
  verify(t, {
    label: "显式打开新键（同时写旧键 false）",
    home: makeHome(patch(["autoArchiveBackfill: true", "autoBackfill: false"])),
    enabled: true,
  });
};

tests["T72 只写旧键 true：旧键不生效，doctor / status 仍报关"] = (t) => {
  verify(t, {
    label: "只写旧键 autoBackfill: true",
    home: makeHome(patch(["autoBackfill: true"])),
    enabled: false,
  });
};
