/**
 * checkup.test.mjs —— 重启后体检脚本（C602）
 *
 * 为什么需要：为了确认「新代码生效没有」，我每次手敲 4~6 条命令人肉比对，
 * 漏看一条就误判。这里把**判定逻辑**钉住：三档 verdict + 「没重启」时不许把
 * 后果当原因。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
export const tests = {};

/** 造一个假 home：build.json + 状态文件，跑 checkup --json 取判定。 */
function runCheckup({ buildId, disk, state }) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "checkup-"));
  const gc = nodePath.join(home, "chess-context");
  nodeFs.mkdirSync(gc, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(gc, "build.json"), JSON.stringify({ buildId, pid: 1, at: Date.now() }));
  if (state !== null) nodeFs.writeFileSync(nodePath.join(gc, "auto-backfill-state.json"), JSON.stringify(state));
  let out = "";
  try {
    out = execFileSync(process.execPath, [nodePath.join(ROOT, "scripts", "checkup.mjs"), "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home, DSH_GOKIFU_FAKE_DISK_BUILD: disk ?? "" },
      timeout: 300_000,
    });
  } catch (error) {
    out = String(error?.stdout ?? "");
  }
  nodeFs.rmSync(home, { recursive: true, force: true });
  return JSON.parse(out || "{}");
}

tests["C602 体检：build 不一致 ⇒ 红，且结论指向「先重启」"] = (t) => {
  const r = runCheckup({
    buildId: "aaaaaaaaaaaa",
    disk: "bbbbbbbbbbbb",
    state: { at: Date.now(), due: 10, picked: ["x"], results: [{ id: "x", folded: 0, stopped: "error" }], doneMs: 1000 },
  });
  t.eq(r.verdict, "red", "旧构建必须是红");
  const row = (r.rows ?? []).find((x) => x.name === "运行实例版本");
  t.includes(String(row?.detail ?? ""), "未生效", "要说清是「未生效」而不是「功能坏了」");
};

tests["C602 体检：健康态（build 一致 + 有产出）⇒ 绿"] = (t) => {
  const r = runCheckup({
    buildId: "same",
    disk: "same",
    state: { at: Date.now(), due: 3, picked: ["a"], results: [{ id: "a", folded: 2, stopped: "done" }], doneMs: 5000 },
  });
  t.eq(r.verdict, "green", `应全绿（实际 ${r.verdict}）`);
};

tests["C602 体检：跑了但一段没折 ⇒ 红（不是黄）"] = (t) => {
  const r = runCheckup({
    buildId: "same",
    disk: "same",
    state: { at: Date.now(), due: 3, picked: ["a"], results: [{ id: "a", folded: 0, stopped: "no-model" }], doneMs: 900 },
  });
  t.eq(r.verdict, "red", "「跑完却零产出」必须红");
  const row = (r.rows ?? []).find((x) => x.name === "自动补账状态");
  t.includes(String(row?.detail ?? ""), "一段都没折", "要给出具体结论");
};

tests["C602 体检：全部在等活跃回合 ⇒ 黄（无人用机时正常）"] = (t) => {
  const r = runCheckup({
    buildId: "same",
    disk: "same",
    state: { at: Date.now(), due: 3, picked: ["a"], results: [{ id: "a", folded: 0, stopped: "inactive-context" }], doneMs: 300 },
  });
  t.eq(r.verdict, "yellow", "等活跃回合是黄，不是红");
};
