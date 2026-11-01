/**
 * preset-discovery.test.mjs —— preset 发现逻辑的**两代兼容**回归（W4，2026-11-01）
 *
 * 为什么要有这个文件：新版 DSH（0.2.1-rc.5）**没有 `<$DSH_HOME>/preset-bundles` 目录了**
 * （用户 preset 改成「bundle 包 + `dsh.profile.bundles` 声明」，patch 里写
 * `name: '@deepseek-ai/dsh-agent-preset'`）。旧代码只认 preset-bundles ⇒ 永远返回 `[]`，
 * UI 的 `findPresetFiles` 与安装器的 `presetsWithCompaction` 会**双双静默找不到 preset**。
 *
 * 本文件钉这些事实：
 *   ① 新形态：bundles 里声明的 preset bundle 能发现，`name` 是 bundle 包名；
 *   ② 没进 `dsh.profile.bundles` 的包**不许**被当 preset（防止把无关包当目标）；
 *   ③ 旧形态：`preset-bundles/<dir>/cordis.patch.yml` 判据与行为不变（老 home 兼容）；
 *   ④ 两代都空 ⇒ `[]` 且**不抛**（home 不存在也一样）；
 *   ⑤ 两份实现（src/ui.mjs / scripts/install.mjs）在同一夹具上返回**逐字段相同**；
 *   ⑥ 本包自己的 bundle patch 不被自指当成 preset；
 *   ⑦ profile 名可参数化（默认 desktop）。
 *
 * 夹具全部建在仓库 `tmp/`（已 gitignore）下，每条用例 finally 清理，**不依赖真实 home**。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { findPresetFiles } from "../src/ui.mjs";
import { presetsWithCompaction } from "../scripts/install.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(REPO, "tmp");
const PKG = "dsh-gokifu-compact";

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 新形态 preset bundle 的 `cordis.patch.yml`。
 * 注意这里**故意不写** `- id: compaction-basic`：本条只能靠 `@deepseek-ai/dsh-agent-preset`
 * 命中，免得「agent-preset 判据失效」被别的判据掩盖成假绿。
 */
const NEW_PRESET_YML = [
  "plugins:",
  "  - insert:",
  "      - id: preset-my-preset",
  "        name: '@deepseek-ai/dsh-agent-preset'",
  "        config:",
  "          id: my-preset",
  "          order: 10",
  "          plugins:",
  "            - id: compaction",
  "              name: '@deepseek-ai/dsh-compaction'",
  "",
].join("\n");

/** 另一种命中判据：只含 `- id: compaction-basic` 的旧式 patch。 */
const COMPACTION_ONLY_YML = [
  "plugins:",
  "  - group: true",
  "    isolate:",
  "      compaction: true",
  "    config:",
  "      - id: compaction-basic",
  "        name: '@deepseek-ai/dsh-compaction-basic'",
  "",
].join("\n");

/** 已经由旧安装器改过的 preset（只剩本包引擎名 —— 对应 PKG_NAME 判据）。 */
const PATCHED_PRESET_YML = [
  "plugins:",
  "  - group: true",
  "    config:",
  "      - id: gokifu-compact",
  `        name: '${PKG}/engine'`,
  "      - id: command-compact",
  "        name: 'dsh-command-compact'",
  "",
].join("\n");

/** 只有本包引擎名的 patch（不含 agent-preset 声明 —— 专门锁 PKG_NAME 判据）。 */
const ENGINE_ONLY_YML = ["plugins:", "  - group: true", "    config:", "      - id: gokifu-compact", `        name: '${PKG}/engine'`, ""].join("\n");

/** 普通 bundle 的 patch（不该被当 preset：三个判据一个都不含）。 */
const PLAIN_BUNDLE_YML = ["- insert:", "    - id: some-plugin", "      name: 'some-plugin'", ""].join("\n");

/** 本包自己的 bundle patch（只插 UI 行，含 PKG_NAME —— 自指防护的夹具）。 */
const OWN_BUNDLE_YML = ["- insert:", "    - id: gokifu-ui", `      name: '${PKG}'`, ""].join("\n");

function mkFixture(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-preset-${label}-`));
}

function cleanup(root) {
  nodeFs.rmSync(root, { recursive: true, force: true });
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

/**
 * 写一个 profile：`<home>/profiles/<profile>/package.json`（dsh.profile.bundles）
 * + `node_modules/<name>/cordis.patch.yml`。
 * @returns {string} profileDir
 */
function writeProfile(home, { profile = "desktop", bundles = [], packages = {} } = {}) {
  const profileDir = nodePath.join(home, "profiles", profile);
  nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
  write(
    nodePath.join(profileDir, "package.json"),
    JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dsh: { profile: { bundles } } }, null, 2) + "\n",
  );
  for (const [name, text] of Object.entries(packages)) {
    write(nodePath.join(profileDir, "node_modules", ...name.split("/"), "cordis.patch.yml"), text);
  }
  return profileDir;
}

/** 发现结果收敛成好比较的形状（排序 + 只留 name/file）。 */
function shape(found) {
  return found
    .map((p) => ({ name: p.name, file: p.file, hasText: typeof p.text === "string" && p.text.length > 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const tests = {
  "新形态：bundles 里声明的 preset bundle（@deepseek-ai/dsh-agent-preset）能被发现，name 是包名"(t) {
    const home = mkFixture("new");
    try {
      const profileDir = writeProfile(home, {
        bundles: ["dsh-base", "my-preset"],
        packages: { "dsh-base": PLAIN_BUNDLE_YML, "my-preset": NEW_PRESET_YML },
      });
      const found = findPresetFiles(home);
      t.eq(found.length, 1, `应只发现 1 个 preset（普通 bundle 不算），实际 ${JSON.stringify(shape(found))}`);
      t.eq(found[0]?.name, "my-preset", "name 必须是 bundle 包名");
      t.eq(found[0]?.file, nodePath.join(profileDir, "node_modules", "my-preset", "cordis.patch.yml"), "file 必须是该包根的 cordis.patch.yml");
      t.includes(found[0]?.text ?? "", "@deepseek-ai/dsh-agent-preset", "text 必须是原文件内容");
    } finally {
      cleanup(home);
    }
  },

  "新形态：node_modules 里有 patch 但 bundles 没列该包 ⇒ 不发现（不许把无关包当 preset）"(t) {
    const home = mkFixture("unlisted");
    try {
      writeProfile(home, {
        bundles: ["dsh-base"], // 只有它被声明
        packages: { "dsh-base": PLAIN_BUNDLE_YML, "rogue-preset": NEW_PRESET_YML }, // rogue 未声明
      });
      const found = findPresetFiles(home);
      t.eq(found.map((p) => p.name), [], "未进 dsh.profile.bundles 的包一律不算 preset");
      t.eq(presetsWithCompaction(home).map((p) => p.name), [], "安装器同样不许把未声明的包当目标");
    } finally {
      cleanup(home);
    }
  },

  "旧形态：没有 profiles 声明，只有 preset-bundles/<dir>/cordis.patch.yml ⇒ 仍能发现（老 home 兼容）"(t) {
    const home = mkFixture("legacy");
    try {
      write(nodePath.join(home, "preset-bundles", "foo", "cordis.patch.yml"), COMPACTION_ONLY_YML);
      write(nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml"), PATCHED_PRESET_YML);
      // 干扰项：preset-bundles 下没有 patch 的目录 / 判据都不含的目录，都不许出现
      nodeFs.mkdirSync(nodePath.join(home, "preset-bundles", "空目录"), { recursive: true });
      write(nodePath.join(home, "preset-bundles", "无关目录", "cordis.patch.yml"), PLAIN_BUNDLE_YML);
      const found = findPresetFiles(home);
      t.eq(
        found.map((p) => p.name).sort(),
        ["foo", "personal-assistant"],
        "旧形态两条判据（compaction-basic / PKG_NAME）都必须继续命中",
      );
      t.eq(
        presetsWithCompaction(home).map((p) => p.name).sort(),
        ["foo", "personal-assistant"],
        "安装器的旧形态行为也要一致",
      );
    } finally {
      cleanup(home);
    }
  },

  "两代都没有 ⇒ 返回 [] 且不抛（空的 / 不存在的 home 都一样）"(t) {
    const home = mkFixture("empty");
    try {
      t.eq(findPresetFiles(home), [], "空 home 应返回 []");
      t.eq(presetsWithCompaction(home), [], "安装器同样返回 []");
      const missing = nodePath.join(home, "根本不存在的-home");
      t.eq(findPresetFiles(missing), [], "home 不存在也不许抛，返回 []");
      t.eq(presetsWithCompaction(missing), [], "安装器同样不许抛");
    } finally {
      cleanup(home);
    }
  },

  "两处实现一致：同一夹具上 findPresetFiles 与 presetsWithCompaction 逐字段相同"(t) {
    const newHome = mkFixture("same-new");
    const oldHome = mkFixture("same-old");
    try {
      // 新形态：三条判据各来一个 + 普通 bundle + 未安装的幽灵 bundle + 本包自身
      writeProfile(newHome, {
        bundles: ["brand-new", "already-patched", "engine-only", "not-a-preset", "ghost-bundle", PKG],
        packages: {
          "brand-new": NEW_PRESET_YML,
          "already-patched": NEW_PRESET_YML.replace("preset-my-preset", "preset-already") + PATCHED_PRESET_YML,
          "engine-only": ENGINE_ONLY_YML,
          "not-a-preset": PLAIN_BUNDLE_YML,
          [PKG]: OWN_BUNDLE_YML,
        },
      });
      const uiNew = findPresetFiles(newHome);
      const installNew = presetsWithCompaction(newHome);
      t.eq(uiNew.length, 3, `三条判据应各命中一个，实际 ${JSON.stringify(shape(uiNew))}`);
      t.eq(installNew, uiNew, "新形态上两份实现必须逐字段相同");

      // 旧形态
      write(nodePath.join(oldHome, "preset-bundles", "personal-assistant", "cordis.patch.yml"), PATCHED_PRESET_YML);
      write(nodePath.join(oldHome, "preset-bundles", "foo", "cordis.patch.yml"), COMPACTION_ONLY_YML);
      const uiOld = findPresetFiles(oldHome);
      const installOld = presetsWithCompaction(oldHome);
      t.eq(uiOld.length, 2, `旧形态应命中 2 个，实际 ${JSON.stringify(shape(uiOld))}`);
      t.eq(installOld, uiOld, "旧形态上两份实现必须逐字段相同");
    } finally {
      cleanup(newHome);
      cleanup(oldHome);
    }
  },

  "本包自己的 bundle patch（name === dsh-gokifu-compact）不被当成 preset（重装/回滚不自指）"(t) {
    const home = mkFixture("self");
    try {
      writeProfile(home, { bundles: [PKG], packages: { [PKG]: OWN_BUNDLE_YML } });
      t.eq(findPresetFiles(home), [], "本包自己的 bundle patch 不是 preset（它只插 UI 行）");
      t.eq(presetsWithCompaction(home), [], "安装器不许把自己当成要改的 preset");
    } finally {
      cleanup(home);
    }
  },

  "profile 名可参数化：非 desktop 的 profile 也能发现，默认仍是 desktop"(t) {
    const home = mkFixture("profile");
    try {
      writeProfile(home, { profile: "superagent", bundles: ["my-preset"], packages: { "my-preset": NEW_PRESET_YML } });
      t.eq(findPresetFiles(home), [], "不传 profile 时默认 desktop，不该看到 superagent 的 preset");
      t.eq(findPresetFiles(home, "superagent").map((p) => p.name), ["my-preset"], "传 profile 名必须能看到");
      t.eq(presetsWithCompaction(home, "superagent").map((p) => p.name), ["my-preset"], "安装器同样可参数化");
    } finally {
      cleanup(home);
    }
  },
};
