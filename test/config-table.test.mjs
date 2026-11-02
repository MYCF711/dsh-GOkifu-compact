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
