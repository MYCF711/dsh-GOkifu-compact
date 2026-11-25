/**
 * rooms-boundary.test.mjs —— 每个房间「只做它那一件事」的边界判据（C678 · 繁复收敛 P2）
 *
 * ## 这里的"边界"指什么
 * 不是"文件大小"，而是**一个房间不许具备它职责之外的能力**：
 *   · 不许起子进程（`node:child_process`）——房间是纯逻辑，不是工装；
 *   · 不许直接连网（`node:http(s)` / `node:net` / `fetch(`）——网络只许经 R09 注入的 port；
 *   · 不许 `eval` / `new Function` —— 配置与图数据都来自外部，动态执行等于把边界拆了；
 *   · `node:fs` 与 `process.env` 是**白名单制**：用到的房间必须逐个登记并写清理由。
 *
 * ## 为什么白名单而不是一刀切禁止 fs
 * `kifu-persist` 的全部职责就是落盘，`migrate` 就是数据迁移 —— 禁掉 fs 等于禁掉这两个房间。
 * 白名单的作用不是"允许"，是**让新增的 fs 使用者必须出现在改动里**（谁加的、为什么加，一眼可见）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
export const tests = {};

/** 允许直接 import `node:fs` 的房间（每个都写清"为什么它必须有 fs"）。 */
const FS_ALLOWED = {
  "backfill-state.mjs": "补账状态落盘：按 pid 一份 + latest 索引 + 旧版单文件（多实例不互相覆盖）",
  "kifu-persist.mjs": "落盘协议的实现者（load / flush / 路径 / delta 回放）",
  "migrate.mjs": "数据迁移：备份 / 应用 / 回滚都要读写 sessions 目录",
  "profile-io.mjs": "profile 文件读写",
  "user-patch.mjs": "用户 patch 文件读写",
  "user-route.mjs": "棋路容器落盘（写 sessions/<id>/user-route.json）",
  "build-stamp.mjs": "构建指纹：读 package/构建产物算戳",
  "offline-fold.mjs": "离线补折：读会话日志为主，落盘由 persist 承担，仍需读文件",
  "world.mjs": "世界状态哈希：对文件做 stat 取 mtime/size",
  "zstd-log.mjs": "会话日志解压读取",
};

/** 允许读 `process.env` 的房间。 */
const ENV_ALLOWED = {
  "migrate.mjs": "迁移 CLI 需要读环境变量决定目标 home（CLI 入口，不是运行期逻辑）",
};

function roomFiles() {
  return nodeFs
    .readdirSync(nodePath.join(ROOT, "src", "rooms"))
    .filter((f) => f.endsWith(".mjs"))
    .sort();
}

function readRoom(name) {
  return nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", name), "utf8");
}

tests["C678 房间不许具备职责之外的能力：子进程 / 网络 / 动态执行一律禁止"] = (t) => {
  const rooms = roomFiles();
  t.ok(rooms.length >= 28, `房间数 ${rooms.length} 小于基线 28（有房间被删了？）`);
  const banned = [
    [/from\s+"node:child_process"/, "子进程（node:child_process）"],
    [/from\s+"node:http"?/, "HTTP 服务（node:http）"],
    [/from\s+"node:https"/, "HTTPS（node:https）"],
    [/from\s+"node:net"/, "裸 socket（node:net）"],
    [/\bfetch\s*\(/, "直接 fetch（网络只许经注入的 port）"],
    [/\beval\s*\(/, "eval"],
    [/new\s+Function\s*\(/, "new Function"],
  ];
  const hits = [];
  for (const name of rooms) {
    const src = readRoom(name);
    for (const [re, what] of banned) if (re.test(src)) hits.push(`${name}: ${what}`);
  }
  t.eq(JSON.stringify(hits), "[]", `房间越界：${JSON.stringify(hits)}`);
};

tests["C678 用 node:fs 的房间必须逐个登记（新增必须出现在改动里）"] = (t) => {
  const users = roomFiles().filter((f) => /from\s+"node:fs"/.test(readRoom(f)));
  t.eq(JSON.stringify(users), JSON.stringify(Object.keys(FS_ALLOWED).sort()), `fs 使用者的集合变了：实际 ${JSON.stringify(users)}`);
  for (const [name, why] of Object.entries(FS_ALLOWED)) {
    t.ok(String(why).length > 6, `${name} 必须写清为什么它需要 fs`);
  }
};

tests["C678 读 process.env 的房间必须逐个登记"] = (t) => {
  const users = roomFiles().filter((f) => /process\.env/.test(readRoom(f)));
  t.eq(JSON.stringify(users), JSON.stringify(Object.keys(ENV_ALLOWED).sort()), `读环境变量的房间变了：实际 ${JSON.stringify(users)}`);
};

tests["C678 房间不许 import engine（方向规则 R-B 的单房版）"] = (t) => {
  const bad = roomFiles().filter((f) => /from\s+"\.\.\/engine\.mjs"/.test(readRoom(f)));
  t.eq(JSON.stringify(bad), "[]", `房间反向依赖 engine：${JSON.stringify(bad)}`);
};