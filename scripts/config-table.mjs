/**
 * config-table.mjs —— 从 SCHEMA 生成「配置总表」（2026-11-02，C249）
 *
 * 为什么要有它：配置项散在 schema / preset 模板 / UI 三处，人读文档时对不上；
 * 而手写的表**一定会漂**（本仓库已经抓过好几次"文档说 A、代码是 B"）。
 * 所以这张表**由代码生成**，`test/config-table.test.mjs` 钉住「文档 == SCHEMA」。
 *
 * 用法：
 *   node scripts/config-table.mjs            # 打印 markdown
 *   node scripts/config-table.mjs --write    # 写回 docs/配置总表.md
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
export const TARGET = nodePath.join(ROOT, "docs", "配置总表.md");

/** `where` 的人话解释（新增作用域时要补一行，测试会抓出"未解释的作用域"）。 */
export const WHERE_TEXT = {
  preset: "preset 模板（`engineBlock()` 生成时会写进你的 preset）",
  engine: "引擎作用域（**不进** preset 模板，写在 preset 的 `config:` 块里也能生效）",
};

function cell(value) {
  const s = value === undefined || value === null || value === "" ? "—" : String(value);
  return s.replace(/\|/g, "\\|");
}

function defaultValueText(field) {
  if (field.type === "boolean") return field.default ? "`true`（默认开）" : "`false`（默认关）";
  if (Array.isArray(field.default)) return field.default.length === 0 ? "`[]`（空数组）" : `\`${JSON.stringify(field.default)}\``;
  if (field.default === "") return "`''`（空）";
  return `\`${field.default}\``;
}

function rangeText(field) {
  if (Array.isArray(field.range)) return `${field.range[0]} – ${field.range[1]}`;
  if (Array.isArray(field.values)) return field.values.map((v) => `\`${v}\``).join(" / ");
  if (field.type === "boolean") return "`true` / `false`";
  if (field.type === "string") return "任意字符串";
  return "—";
}

/**
 * 生成整份文档（纯函数，便于测试比对）。
 * @param {Array<object>} schema
 * @returns {string}
 */
export function renderConfigTable(schema) {
  const rows = [...schema]
    .filter((f) => f && typeof f.key === "string")
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((f) => `| \`${f.key}\` | ${cell(f.label)} | ${cell(f.desc)} | ${defaultValueText(f)} | ${rangeText(f)} | ${cell(WHERE_TEXT[f.where] ?? f.where)} |`);

  return [
    "# 配置总表（由代码生成，别手改）",
    "",
    "> **这份文件由 `scripts/config-table.mjs` 从 `src/rooms/config-schema.mjs` 生成。**",
    "> 手改会被 `test/config-table.test.mjs` 打回 —— 要改配置项，改 schema 再 `node scripts/config-table.mjs --write`。",
    "> 生成时间不写进文件（否则每次生成都产生 diff，没人能看出真正的变化）。",
    "",
    `共 **${rows.length}** 项。`,
    "",
    "| 键 | 中文名 | 说明 | 默认 | 范围 / 取值 | 作用域 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## 两个作用域的区别",
    "",
    ...Object.entries(WHERE_TEXT).map(([k, v]) => `- **${k}** — ${v}`),
    "",
    "## 怎么改",
    "",
    "```bash",
    "# 推荐：走设置 UI（内部串行 + 失败回滚）",
    "# 或者手改 preset 的 config: 块，然后重启 DSH 让它生效",
    "```",
    "",
    "> 铁律：**不要**在会话里直接写 `home\\profiles\\*\\cordis.patch.yml`（热重载会打断子代理）。",
    "",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const schemaMod = "./src/rooms/config-schema.mjs";
  return import(pathToFileURL(nodePath.join(ROOT, schemaMod)).href).then((mod) => {
    const text = renderConfigTable(mod.SCHEMA);
    if (argv.includes("--write")) {
      nodeFs.writeFileSync(TARGET, text, "utf8");
      process.stdout.write(`已写入 ${nodePath.relative(ROOT, TARGET)}（${mod.SCHEMA.length} 项）\n`);
      return 0;
    }
    process.stdout.write(text);
    return 0;
  });
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
