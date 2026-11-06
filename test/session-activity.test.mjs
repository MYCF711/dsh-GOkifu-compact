import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { indexSessionLogs, isSessionActive, latestSessionWrite } from "../scripts/session-activity.mjs";

export const tests = {};

tests["T97 活动会话：最近日志写入在窗口内 ⇒ active；旧日志 ⇒ inactive"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "active-session-"));
  try {
    const now = Date.now();
    t.eq(latestSessionWrite(dir), null, "空目录没有日志");
    t.eq(isSessionActive(dir, { now }), false, "空目录不算活动");
    const old = nodePath.join(dir, "old.v4.jsonl.zstd");
    nodeFs.writeFileSync(old, "x");
    nodeFs.utimesSync(old, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
    t.eq(isSessionActive(dir, { now, windowMs: 15 * 60 * 1000 }), false, "1 小时前的日志已不活跃");
    const fresh = nodePath.join(dir, "fresh.v4.jsonl.zstd");
    nodeFs.writeFileSync(fresh, "y");
    t.eq(isSessionActive(dir, { now, windowMs: 15 * 60 * 1000 }), true, "最新日志在窗口内 ⇒ 活跃");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["T97 日志与棋谱分树：通过 home 索引仍能识别活跃会话"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "active-home-"));
  try {
    const now = Date.now();
    const sessionId = "fixture";
    const graphDir = nodePath.join(home, "chess-context", "sessions", `session-${sessionId}`);
    const logDir = nodePath.join(home, "sessions", "workspace-a", `session-${sessionId}`);
    nodeFs.mkdirSync(graphDir, { recursive: true });
    nodeFs.mkdirSync(logDir, { recursive: true });
    const log = nodePath.join(logDir, "session.v4.jsonl.zstd");
    nodeFs.writeFileSync(log, "x");
    nodeFs.utimesSync(log, new Date(now), new Date(now));
    const index = indexSessionLogs(home);
    t.eq(index.has(sessionId), true, "索引按去前缀 session id 建键");
    t.eq(isSessionActive(graphDir, { now, logIndex: index }), true, "棋谱目录本身无日志时，仍能从索引判活跃");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
