/**
 * small-window-oom.test.mjs —— T69：真机规模下，小窗口审计必须在默认内存量级跑完。
 *
 * 修前：eventCache 把每个会话的完整事件数组留到进程结束，默认堆在扫描阶段 OOM（exit 134），
 * --no-replay 也一样。这里用比默认堆更小的 1 GiB 上限跑完整 --json（含反事实重放）：
 * 这是回归守卫，不是用 --max-old-space-size 掩盖问题；修后默认命令另由验收实跑。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveHome } from "../scripts/summary-usability-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "small-window-audit.mjs");

export const tests = {};

tests["T69 真机 1100+ 折痕：完整 small-window --json 在 1 GiB 堆内跑完且退出 0"] = (t) => {
  const home = resolveHome();
  t.eq(nodeFs.existsSync(nodePath.join(home, "chess-context", "sessions")), true, `真机棋谱目录必须存在：${home}`);

  const run = spawnSync(process.execPath, ["--max-old-space-size=1024", SCRIPT, "--json"], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  t.eq(run.error, undefined, `子进程不能启动失败或超时：${String(run.error ?? "")}`);
  t.eq(run.signal, null, `不能被杀掉：${String(run.signal ?? "")}`);
  t.eq(run.status, 0, `真机完整审计必须退出 0（修前这里为 134）：\n${String(run.stderr ?? "").slice(-8000)}`);
  if (run.status !== 0) return;

  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch (error) {
    t.ok(false, `stdout 必须是完整 JSON：${String(error)}\n${String(run.stdout).slice(0, 1000)}`);
    return;
  }
  t.ok(result.sessions >= 400, `必须真的扫到真机会话规模，实际 ${result.sessions}`);
  t.ok(result.marks >= 1100, `必须真的扫到 1100+ 折痕，实际 ${result.marks}`);
  t.eq(result.rows, result.marks, "JSON 的 rows 计数口径不变");
  t.ok(result.replayResult !== null && result.replayResult !== undefined, "必须执行反事实重放，不能用 --no-replay 躲过 OOM 路径");
  t.ok(result.replayResult.marks > 0, "真机小窗口重放样本不能为空");
};
