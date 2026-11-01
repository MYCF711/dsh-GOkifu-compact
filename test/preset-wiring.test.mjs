/**
 * preset-wiring.test.mjs —— doctor / verify-install 的 preset 检查「两代兼容 + 语义分档」回归（W5，2026-11-01）
 *
 * 为什么要有这个文件：
 *   ① 这两处以前都写死 `<DSH_HOME>/preset-bundles/personal-assistant/cordis.patch.yml`，
 *      新版 DSH（0.2.1-rc.5）没有 preset-bundles ⇒ 在新 home 上**必然假红**。
 *   ② 更关键的是**语义**：新版 home 还没自建 preset 时，「找不到 preset」是**合法中间态**，
 *      不是错误；但「**有** preset 却缺 gokifu 引擎行」必须红。两种状态必须分开断言，
 *      不许糊成一个布尔（否则要么全是假红，要么全是假绿）。
 *
 * 本文件钉四件事（verify-install 与 doctor 两个入口都要断言，防止只有一处改对）：
 *   ① 新形态 preset（profile 的 dsh.profile.bundles → bundle 包根 cordis.patch.yml）能命中 ⇒ 已挂/可挂；
 *   ② 两代都没有 ⇒ 中性（severity:"warn"，不计入 failed；doctor 里是 warn 不是 error）；
 *   ③ 旧形态 preset 存在但缺引擎行 ⇒ 红/错误（不许沿用「没有 preset」的中性待遇）；
 *   ④ 新形态 preset 存在但缺引擎行 ⇒ 同样红/错误。
 *
 * 夹具全部建在仓库 `tmp/`（已 gitignore）下，每条用例 finally 清理；不依赖真实 home。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyInstall } from "./verify-install.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(REPO, "tmp");
const DOCTOR = nodePath.join(REPO, "scripts", "doctor.mjs");

/* ───────────────────────── 夹具 ───────────────────────── */

/** 新形态 preset bundle 的 cordis.patch.yml：agent-preset 声明（可选挂 gokifu 引擎行）。 */
function newPresetYml({ engine = true } = {}) {
  const plugins = engine
    ? [
        "          - id: compaction-group",
        "            name: cordis:group",
        "            group: true",
        "            isolate:",
        "              compaction: true",
        "            config:",
        "              - id: gokifu-compact",
        "                name: 'dsh-gokifu-compact/engine'",
        "              - id: command-compact",
        "                name: 'dsh-command-compact'",
        "              - id: tool-result-pruner",
        "                name: 'dsh-compaction-tool-result-pruner'",
      ]
    : ["          - id: compaction-group", "            name: cordis:group", "            group: true"];
  return [
    "plugins:",
    "  - insert:",
    "      - id: preset-my-preset",
    "        name: '@deepseek-ai/dsh-agent-preset'",
    "        config:",
    "          id: my-preset",
    "          order: 10",
    "          plugins:",
    ...plugins,
    "",
  ].join("\n");
}

/** 旧形态 preset（还停在 compaction-basic 上 —— 「有 preset 但没挂引擎行」的最典型形状）。 */
const LEGACY_PRESET_YML = [
  "plugins:",
  "  - group: true",
  "    isolate:",
  "      compaction: true",
  "    config:",
  "      - id: compaction-basic",
  "        name: '@deepseek-ai/dsh-compaction-basic'",
  "      - id: command-compact",
  "        name: 'dsh-command-compact'",
  "      - id: tool-result-pruner",
  "        name: 'dsh-compaction-tool-result-pruner'",
  "",
].join("\n");

function mkHome(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-preset-wiring-${label}-`));
}

function cleanup(home) {
  nodeFs.rmSync(home, { recursive: true, force: true });
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

/** 写一个「可读」的 profile 清单（没有 preset 时，这是「合法中间态」成立的前提）。 */
function writeProfile(home, bundles = []) {
  write(
    nodePath.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ name: "dsh-profile-desktop", private: true, dsh: { profile: { bundles } } }, null, 2) + "\n",
  );
}

/** 新形态：profile 声明 bundle + 包根 cordis.patch.yml。 */
function writeNewPreset(home, name, opts) {
  write(nodePath.join(home, "profiles", "desktop", "node_modules", ...name.split("/"), "cordis.patch.yml"), newPresetYml(opts));
  write(
    nodePath.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ name: "dsh-profile-desktop", private: true, dsh: { profile: { bundles: [name] } } }, null, 2) + "\n",
  );
}

function named(result, fragment) {
  return result.checks.find((c) => c.name.includes(fragment));
}

function presetChecks(result) {
  return result.checks.filter((c) => c.name.startsWith("preset "));
}

/** 跑 doctor --json（doctor 有 error 时退出码 1，但 --json 仍会输出完整 JSON）。 */
function doctorJson(home) {
  try {
    const out = execFileSync(process.execPath, [DOCTOR, "--json"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home },
      timeout: 60000,
      windowsHide: true,
    });
    return JSON.parse(out);
  } catch (error) {
    return JSON.parse(String(error.stdout ?? "{}"));
  }
}

/** doctor 里与 preset 语义相关的 4 条检查项（名字是 doctor 的既有口径）。 */
const DOCTOR_PRESET_NAMES = [
  "preset 引用了 dsh-gokifu-compact",
  "preset 里没有 compaction-basic（单实例）",
  "压缩后端已接管（preset 里是 gokifu-compact）",
  "原生 compaction-basic 已让位（单实例）",
];

function doctorPresetChecks(doc) {
  return DOCTOR_PRESET_NAMES.map((name) => doc.checks.find((c) => c.name === name));
}

export const tests = {
  "① 新形态 preset 命中（profile 的 dsh.profile.bundles → bundle 包根 patch）⇒ verify-install 与 doctor 都认「已挂」"(t) {
    const home = mkHome("new");
    try {
      writeNewPreset(home, "my-preset", { engine: true });
      const result = verifyInstall({ dshHome: home, profile: "desktop", preset: "my-preset" });
      const engine = named(result, "preset 引用了 dsh-gokifu-compact/engine");
      t.ok(engine !== undefined, "preset 组里必须有「引用了引擎」这条（不许整组消失 = 假绿）");
      t.eq(engine.ok, true, `新形态 preset 里的引擎行必须被认出来：${engine.detail}`);
      t.eq(named(result, "preset 里没有 compaction-basic")?.ok, true, "新形态 preset 未挂原生后端");
      t.eq(named(result, "引擎行仍在 isolate")?.ok, true, "isolate:{compaction:true} 必须还在");
      // 「命中」分支的 5 条里只有 4 条以 "preset " 开头（isolate 这条名字以「引擎行」开头），
      // 所以按完整名字核对，避免用前缀过滤把 isolate 那条漏掉还自以为查了 5 条。
      const presentNames = [
        "preset 引用了 dsh-gokifu-compact/engine",
        "preset 里没有 compaction-basic（单实例）",
        "preset 保留 command-compact",
        "preset 保留 tool-result-pruner",
        "引擎行仍在 isolate:{compaction:true} 的 group 内",
      ];
      const pc = presentNames.map((name) => result.checks.find((c) => c.name === name));
      t.ok(pc.every((c) => c !== undefined), `preset 组 5 条一条都不许少：${presentNames.filter((n, i) => pc[i] === undefined).join(" / ")}`);
      t.ok(pc.every((c) => c.ok === true), `新形态命中时 preset 组必须全绿：${pc.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join(" / ")}`);
      t.eq(
        result.checks.filter((c) => c.severity === "warn").length,
        0,
        "命中时不许再出现「合法中间态」的中性项",
      );

      const doc = doctorJson(home);
      for (const check of doctorPresetChecks(doc)) {
        t.eq(check?.status, "ok", `doctor 也必须用同一份发现逻辑认出新形态 preset（${check?.name}：${check?.detail}）`);
      }
      t.eq(
        doc.checks.filter((c) => c.status === "error").map((c) => c.name),
        ["插件已链接进 profile"],
        "只剩「安装态」1 条错误；preset 组不许在健康 preset 上报错",
      );
    } finally {
      cleanup(home);
    }
  },

  "② 两代都没有 preset ⇒ 中性（合法中间态）：ok=false 但 severity=warn、不计入 failed；doctor 是 warn 不是 error"(t) {
    const home = mkHome("absent");
    try {
      writeProfile(home, []); // 可读的 profile 清单 + 没有任何 preset
      const result = verifyInstall({ dshHome: home, profile: "desktop", preset: "personal-assistant" });
      const pc = presetChecks(result);
      t.eq(pc.length, 5, "preset 组仍是 5 条（数量恒定）");
      t.ok(pc.every((c) => c.ok === false), "找不到 preset 时 ok 仍是 false（不许把「没查到」藏成绿）");
      t.ok(pc.every((c) => c.severity === "warn"), `但 severity 必须是 warn（合法中间态）：${pc.map((c) => `${c.name}=${c.severity}`).join(" / ")}`);
      t.eq(result.warnings, 5, "5 条中性提示");
      // 这个夹具里非 preset 的 13 条仍红，中性 5 条不计入 failed
      t.eq(result.failed, 13, "failed 只算真失败（13 条），5 条中性不许计入");
      const fileCheck = pc.find((c) => c.name === "preset 文件存在");
      t.includes(fileCheck.detail, "合法中间态", "结论必须可读：说明这是合法中间态而不是笼统失败");
      t.includes(fileCheck.detail, "自建 preset bundle", "要告诉人下一步怎么做（自建 preset bundle 再 install）");

      const doc = doctorJson(home);
      for (const check of doctorPresetChecks(doc)) {
        t.eq(check?.status, "warn", `没有 preset 时 doctor 只许提示(warn)，不许 error（${check?.name}：${check?.detail}）`);
      }
      // 「没有 preset」不再制造 doctor 错误：唯一错误只剩安装态那 1 条（改前是 3 条）
      t.eq(doc.checks.filter((c) => c.status === "error").map((c) => c.name), ["插件已链接进 profile"], "doctor 的错误里不许再出现 preset 相关项");
      t.eq(doc.bad, 1, "doctor 错误数：只有安装态 1 条");
    } finally {
      cleanup(home);
    }
  },

  "③ 旧形态 preset 存在但缺引擎行 ⇒ 必须红（不许沿用「没有 preset」的中性待遇）"(t) {
    const home = mkHome("legacy-noengine");
    try {
      writeProfile(home, []);
      write(nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml"), LEGACY_PRESET_YML);
      const result = verifyInstall({ dshHome: home, profile: "desktop", preset: "personal-assistant" });
      const engine = named(result, "preset 引用了 dsh-gokifu-compact/engine");
      t.eq(engine?.ok, false, "有 preset 但没挂引擎行 ⇒ 这条必须红");
      t.eq(engine?.severity, "error", "而且必须是 error（不是「没有 preset」那种 warn）");
      t.eq(named(result, "preset 里没有 compaction-basic")?.ok, false, "旧形态仍挂着 compaction-basic ⇒ 单实例这条也红");
      t.ok(
        presetChecks(result).every((c) => c.severity !== "warn"),
        "有 preset 时 preset 组不许再出现中性项（中性只属于「两代都没有」）",
      );
      t.ok(result.failed > 13, `有 preset 但缺引擎行 ⇒ 失败数必须高于「没有 preset」的 13，实际 ${result.failed}`);

      const doc = doctorJson(home);
      const docEngine = doc.checks.find((c) => c.name === "preset 引用了 dsh-gokifu-compact");
      const docBackend = doc.checks.find((c) => c.name === "压缩后端已接管（preset 里是 gokifu-compact）");
      t.eq(docEngine?.status, "error", `doctor 必须报错（不是 warn）：${docEngine?.detail}`);
      t.eq(docBackend?.status, "error", `doctor「压缩后端已接管」必须报错：${docBackend?.detail}`);
      t.ok(doc.bad >= 2, `doctor 错误数必须增加（preset 相关至少 2 条），实际 ${doc.bad}`);
    } finally {
      cleanup(home);
    }
  },

  "④ 新形态 preset 存在但缺引擎行 ⇒ 同样必须红（两代同一语义）"(t) {
    const home = mkHome("new-noengine");
    try {
      writeNewPreset(home, "my-preset", { engine: false });
      const result = verifyInstall({ dshHome: home, profile: "desktop", preset: "my-preset" });
      const engine = named(result, "preset 引用了 dsh-gokifu-compact/engine");
      t.eq(engine?.ok, false, "新形态 preset 存在但没挂引擎行 ⇒ 必须红");
      t.eq(engine?.severity, "error", "而且是 error（不是「没有 preset」的 warn）");
      t.ok(result.failed > 13, `失败数必须高于「没有 preset」的 13，实际 ${result.failed}`);

      const doc = doctorJson(home);
      const docEngine = doc.checks.find((c) => c.name === "preset 引用了 dsh-gokifu-compact");
      t.eq(docEngine?.status, "error", `doctor 对新形态「有 preset 没挂」也必须报错：${docEngine?.detail}`);
      t.eq(
        doc.checks.find((c) => c.name === "压缩后端已接管（preset 里是 gokifu-compact）")?.status,
        "error",
        "doctor「压缩后端已接管」同样必须报错",
      );
    } finally {
      cleanup(home);
    }
  },
};
