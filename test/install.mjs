/**
 * test/install.mjs —— 薄封装：真正的安装器在 `scripts/install.mjs`（随 npm 包发布）。
 *
 * 为什么改：安装要「一条命令、不手改 YAML」。逻辑只有一份，放在 scripts/ 里才能被
 * `npx dsh-gokifu-compact install` 直接调用；测试与文档都指向它，避免两份实现走偏。
 *
 *   node test/install.mjs --dry-run
 *   node test/install.mjs --profile desktop --preset personal-assistant
 *   node test/rollback.mjs      # 回滚
 */
import { run } from "../scripts/install.mjs";

process.exitCode = run(process.argv.slice(2));
