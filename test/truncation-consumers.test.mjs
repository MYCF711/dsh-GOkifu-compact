/**
 * truncation-consumers.test.mjs —— 「截断可见性」的另外两个消费点（C611）
 *
 * 背景（真机 2026-11-05）：`src/ui.mjs` 已按 C609 改成「或」逻辑 ——
 *   `finishReason` 是截断类 **或** `truncated === true` ⇒ 算截断（离线补折不写 `finishReason`，
 *   因为上游 finish 在写入点取不到；真机 283/462 条 foldMark 是离线补折）。
 *
 * 但另外两个消费点仍只读 `finishReason`，于是对离线 mark 一律报「未采集」：
 *   ① `scripts/doctor.mjs` 的「摘要截断（stopReason=max_tokens）」巡检；
 *   ② `scripts/accept-after-restart.mjs` 的 `scanEvidence()` 快照。
 *
 * 这个文件把三态钉死（三组夹具各跑真实 doctor 子进程 + 真实 scanEvidence）：
 *   夹具一 `truncated:true`、**无** `finishReason` ⇒ 算截断（旧实现判「未采集」⇒ 本文件必红）；
 *   夹具二 `truncated:false`、无 finish     ⇒ 算「没截断」，**不算**「不知道」；
 *   夹具三 两者都没有                        ⇒ 明确记「不知道」并给出条数（不许并进「没截断」）。
 *
 * 只读：临时 home 在 `os.tmpdir()`，跑完删除；不碰真实 `DSH_HOME`。
 */
import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { scanEvidence, verdictOf } from "../scripts/accept-after-restart.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const NOW = Date.now();

/** 造一个最小 home（只有 chess-context/sessions/<sid>/graph.json 里的一条 foldMark 序列）。 */
function makeHome(foldMarks, sessionId = "session-truncation") {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-truncation-"));
  const dir = nodePath.join(root, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = { version: 1, sessionId, nodes: {}, edges: {}, order: [], foldCount: foldMarks.length, foldMarks };
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
  return root;
}

const sessionsRootOf = (home) => nodePath.join(home, "chess-context", "sessions");

/** 跑真实 doctor 子进程（`--json`），取出「摘要截断」那一行。 */
function runDoctor(home) {
  let out;
  try {
    out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "doctor.mjs"), "--json"], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // doctor 有 warn 时退出码非 0 —— stdout 仍是完整 JSON
    out = error && typeof error.stdout === "string" ? error.stdout : "";
  }
  const payload = JSON.parse(out);
  return payload.checks.find((c) => String(c.name).startsWith("摘要截断"));
}

const mark = (extra = {}) => ({
  at: NOW,
  trigger: "archive-offline",
  offline: true,
  shadowedTokens: 1000,
  summaryChars: 3000,
  ...extra,
});

tests["C611 夹具一：离线 mark（truncated:true、无 finishReason）⇒ doctor 报被截断，不再说「未采集」"] = (t) => {
  const home = makeHome([mark({ truncated: true })]);
  try {
    const row = runDoctor(home);
    t.eq(!!row, true, "必须有「摘要截断」这一行");
    t.eq(row.status, "warn", "truncated:true 是截断证据 ⇒ 必须 warn");
    t.notIncludes(String(row.detail), "未采集", "有 truncated:true 就不许说「未采集」（旧实现正是这么报的）");
    t.includes(String(row.detail), "被截断", "要明说「被截断」");
    t.includes(String(row.detail), "truncated", "要点名证据来自 `truncated` 字段（离线补折拿不到上游 finish）");
    t.includes(String(row.detail), "1", "要给出截断条数");

    // 同一个 home 上，accept-after-restart 的快照里也必须看得到
    const snap = scanEvidence(sessionsRootOf(home));
    t.eq(
      snap.truncation,
      { collected: 1, truncated: 1, fromTruncated: 1, unknown: 0 },
      "scanEvidence 快照：1 条有证据、1 条被截断、其中 1 条来自 truncated、0 条不知道",
    );
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C611 夹具二：truncated:false、无 finish ⇒ 算「没截断」，不算「不知道」"] = (t) => {
  const home = makeHome([mark({ truncated: false })]);
  try {
    const row = runDoctor(home);
    t.eq(!!row, true, "必须有「摘要截断」这一行");
    t.eq(row.status, "ok", "明确写完了 ⇒ 不是警告");
    t.notIncludes(String(row.detail), "未采集", "truncated:false 是有证据的「没截断」，不许说未采集");
    t.notIncludes(String(row.detail), "不知道", "truncated:false 不是「不知道」");
    t.includes(String(row.detail), "0", "要给出截断条数 0");

    const snap = scanEvidence(sessionsRootOf(home));
    t.eq(
      snap.truncation,
      { collected: 1, truncated: 0, fromTruncated: 0, unknown: 0 },
      "scanEvidence 快照：1 条有证据、0 条截断、0 条不知道",
    );
    // 有证据 ⇒ 验收判定里不许再冒出「截断仪器未采集」
    const v = verdictOf({
      caps: { level: "ok", known: [], unknown: [] },
      backfill: { reachable: true, due: 0, error: null },
      closeout: { seen: true, sessions: 1 },
      truncation: snap.truncation,
      buildOk: true,
    });
    t.eq(v.todo.some((x) => x.includes("截断仪器")), false, "collected>0 时不许报「截断仪器未采集」");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C611 夹具三：两个字段都没有 ⇒ 明确记「不知道」并给出条数（不许并进「没截断」）"] = (t) => {
  const home = makeHome([mark({ offline: false })]);
  try {
    const row = runDoctor(home);
    t.eq(!!row, true, "必须有「摘要截断」这一行");
    t.eq(row.status, "warn", "不知道必须 warn（旧记录不许当 ok）");
    t.includes(String(row.detail), "不知道", "要明说「不知道有没有被截断」");
    t.includes(String(row.detail), "未采集", "老记录仍要说「未采集」（C317 的既有判据）");
    t.includes(String(row.detail), "1 条", "要说明有几条不知道");

    const snap = scanEvidence(sessionsRootOf(home));
    t.eq(
      snap.truncation,
      { collected: 0, truncated: 0, fromTruncated: 0, unknown: 1 },
      "scanEvidence 快照：0 条有证据、0 条截断、1 条不知道",
    );
    const v = verdictOf({
      caps: { level: "ok", known: [], unknown: [] },
      backfill: { reachable: true, due: 0, error: null },
      closeout: { seen: true, sessions: 1 },
      truncation: snap.truncation,
      buildOk: true,
    });
    t.eq(v.todo.some((x) => x.includes("不知道")), true, "不知道必须在待办里明说（不许静默当没截断）");
    t.includes(v.todo.join("\n"), "1 条", "待办里要给出不知道的条数");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C611 三态互不合并：两种证据同时在场只算一次，stop 类进「有证据」而不是「不知道」"] = (t) => {
  // 一个 home 里三种 mark：截断（两个字段都在）、明确没截断（上游 stop）、不知道（两个都没有）
  const home = makeHome([
    mark({ finishReason: "length", truncated: true }),
    mark({ finishReason: "end_turn", offline: false }),
    mark({ offline: false }),
  ]);
  try {
    const snap = scanEvidence(sessionsRootOf(home));
    t.eq(snap.truncation.truncated, 1, "同一次折叠有两个证据也只能算一次截断");
    t.eq(snap.truncation.fromTruncated, 1, "来自 truncated 字段的是 1 条");
    t.eq(snap.truncation.collected, 2, "有证据的是 2 条（截断 1 + 明确没截断 1）");
    t.eq(snap.truncation.unknown, 1, "只有两个字段都没有的那条算不知道");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
