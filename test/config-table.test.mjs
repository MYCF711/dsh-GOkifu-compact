/**
 * config-table.test.mjs —— 「配置总表」必须等于 SCHEMA 生成的结果（C249）
 *
 * 为什么：配置项散在 schema / preset 模板 / UI 三处，手写文档一定会漂。
 * 这条测试让 docs/配置总表.md **只能是生成物**：改了 schema 忘了重新生成 ⇒ 红。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const tests = {};

const loadTable = () => import(pathToFileURL(nodePath.join(ROOT, "scripts", "config-table.mjs")).href);
const loadSchema = () => import(pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href);

tests["C249 配置总表 == SCHEMA 生成结果（漂了就红；且每项都有一行）"] = async (t) => {
  const table = await loadTable();
  const { SCHEMA } = await loadSchema();
  const disk = nodeFs.readFileSync(nodePath.join(ROOT, "docs", "配置总表.md"), "utf8");
  const fresh = table.renderConfigTable(SCHEMA);
  t.eq(disk === fresh, true, "docs/配置总表.md 与 SCHEMA 不一致 —— 跑 `node scripts/config-table.mjs --write`");

  // 每一项都必须真的出现在表里（防止生成器漏排）
  for (const field of SCHEMA) {
    t.includes(disk, `\`${field.key}\``, `配置项 ${field.key} 必须出现在总表里`);
  }
  // 作用域必须都有解释（新增作用域却没人话解释 ⇒ 红）
  const wheres = [...new Set(SCHEMA.map((f) => f.where))];
  for (const where of wheres) {
    t.eq(typeof table.WHERE_TEXT[where], "string", `作用域 ${where} 必须有中文解释`);
  }
  // 生成物不许带时间戳（否则每次都 diff）
  t.eq(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(disk), false, "总表里不许出现 ISO 时间戳");
};

tests["C249 生成器是纯函数：同样输入两次结果完全一致（可复现）"] = async (t) => {
  const table = await loadTable();
  const { SCHEMA } = await loadSchema();
  t.eq(table.renderConfigTable(SCHEMA), table.renderConfigTable(SCHEMA), "同一份 schema 生成两次必须逐字节相同");
};

tests["C250 CLI 与打包：`config` 子命令必须可达，且总表随包发布"] = async (t) => {
  const nodeFsL = nodeFs;
  const cli = nodeFsL.readFileSync(nodePath.join(ROOT, "scripts", "cli.mjs"), "utf8");
  t.includes(cli, 'command === "config"', "cli.mjs 必须认识 config 子命令");
  t.includes(cli, 'nodePath.join(HERE, "config-table.mjs")', "config 必须路由到同目录的 config-table.mjs（不是 test/ 下的东西）");
  t.includes(cli, "dsh-gokifu-compact config [--write]", "帮助文本必须列出 config");

  // 打包白名单：docs 与 scripts 都得在，否则装好的用户既没有表也跑不了生成器
  const pkg = JSON.parse(nodeFsL.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));
  t.eq(pkg.files.includes("docs"), true, "files 必须含 docs（配置总表随包发）");
  t.eq(pkg.files.includes("scripts"), true, "files 必须含 scripts（config-table.mjs 随包发）");
  t.eq(nodeFsL.existsSync(nodePath.join(ROOT, "docs", "配置总表.md")), true, "总表文件必须存在");
  t.eq(nodeFsL.existsSync(nodePath.join(ROOT, "scripts", "config-table.mjs")), true, "生成器必须存在");
};
