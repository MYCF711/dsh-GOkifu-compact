# 更新与发布

## 铁律

1. **`cordis.patch.yml` 是生成物，不是手写文件。** 它由 `node scripts/make-presets-override.mjs --write`
   从**宿主 asar 里的官方 preset** 文本级改写而来。手改它 = 下次生成时被覆盖 + 生成器自检不过。
2. **默认分支只接受通过门禁的 PR**；`main` 永远可安装。
3. **npm 只发稳定版** `x.y.z`（不带 `-rc` / `-beta` / `-stage`）；预发布只走 GitHub tag / Release。
4. **tag 必须是 annotated**：`git tag -a <tag> -m "release <tag>"`。lightweight tag 只指向 commit，
   GitHub Release 的 Tag 一栏会是空的、「这一版改了什么」在 tag 上查不回来。
   （`scripts/check-maintenance.mjs` 有静态断言盯着这条，谁改回 lightweight 立刻红。）
5. **改 `README.md` = 改发布包**：npm 强制包含 `README.md` / `package.json`，即使不在 `files` 里。
   （1.9.2 就是因为 `README:3` 版本行漏改，被迫发 1.9.3；npm 不可变，发出去的错改不回来。）

## 发一个版本（标准流程）

```bash
# 1) 改代码 + 补测试
node test/run.mjs                        # 必须串行：并发会抢 test/.harness ⇒ 假红

# 2) bump 版本 + 写 CHANGELOG
#    语义化：修 bug → patch；加能力 → minor；改默认行为 / 改 preset 行 id → major
#    五处必须一起改：package.json / README 版本行 / CHANGELOG / cordis.patch.yml 里的包名引用 / 面板文案
node scripts/check-maintenance.mjs       # 会告诉你哪处没对齐

# 3) 文档计数同步（加了测试就必须跑，见 CONTRIBUTING.md）
npm run gate
node scripts/sync-doc-numbers.mjs --write
node scripts/sync-doc-numbers.mjs --check

# 4) 全量门禁（不是 --fast）
npm run gate                             # 8 判分门 + 5 条参考门

# 5) 提交 + 打 tag + 推（**commit 与 tag 一起推**）
#    先推 commit 再补 tag，CI 会在「维护一致性」那一步红（tag 还不存在）。
git add <具体文件>                        # 并行开发中禁用 git add -A
git commit -m "fix: ..."
git tag -a v<版本> -m "release v<版本>"
git push origin main v<版本>

# 6) 发布（事务化：前一步失败后面根本不执行）
node scripts/release.mjs                 # 预演：列计划 + 逐项体检，什么都不改
node scripts/release.mjs --yes --npm     # tag + push + npm publish + GitHub Release + 后置验证

# 7) 看 CI 有没有绿（PR 会跳过维护一致性，main 上必须绿）
gh run list --workflow ci --limit 3
```

> `release.mjs --yes --npm` 在 publish 之后会**自动**跑 `release-post-verify.mjs`：
> 轮询 `npm view <pkg>@<version> version` 直到传播完成（默认超时 180s / 间隔 5s），
> 再核对 `dist-tags.latest`、tarball 内 CHANGELOG 的版本段、逐文件比对、GitHub Release 非 draft。
> **任何一步失败都非零退出，并明确写「publish 已完成，不要重跑发布事务」。**

## ⚠ 改了 DSH 版本之后必须重跑生成器

`cordis.patch.yml` 里的 preset 清单是**按宿主版本生成的快照**（生成时读取宿主 asar 里的官方 preset）。
DSH 升级 ⇒ 官方 preset 的形状可能变 ⇒ **必须重跑**：

```bash
node scripts/make-presets-override.mjs           # 干跑：看将从当前宿主 asar 生成什么
node scripts/make-presets-override.mjs --write   # 重写仓库根的 cordis.patch.yml
```

生成器有三条机器判据，**漏了会拒绝产出**：

1. **不新增 preset** —— 只覆盖官方已有的 `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`；
2. **引擎行恰好 4 条** —— 每个 preset 的 compaction group 里只有 `<pkg>/engine`，**没有** `compaction-basic`；
3. **`!!js` 表达式逐字保留** —— 官方文件里的 `!!js` 绝不能被 YAML round-trip。

> **为什么不再兜底到历史写死的宿主路径**：静默用**旧宿主**生成「看起来对」的产物，比找不到更危险 ——
> 那正是 2026-11-07「随包 patch 引用宿主已删除的 `list-agents` 子路径」事故的成因。
> 现在的解析顺序是 `DSH_APP_ASAR` → `DSH_HOME` 父目录下的同级安装 → 当前进程安装 → 平台标准位置，
> **一个都找不到就报错退出**，不猜。

## 发布后必须核对

```bash
node scripts/check-maintenance.mjs                 # 六项：CHANGELOG / tag / 版本一致
node scripts/verify-release.mjs --tag=v<版本>      # 逐文件比对「发布物 == tag 那棵树」
node scripts/release-post-verify.mjs               # 后置验证（也可单独跑）
gh release view v<版本> --repo MYCF711/dsh-GOkifu-compact --json name,isLatest
node -p "require('<安装副本>/package.json').version"
```

## 用户怎么升级

优先在**面板**里操作：**设置 → 上下文压缩 → 检查更新**（只拼命令，**绝不执行安装**）。

也可以在终端运行：

```bash
dsh plugin --profile <p> add dsh-gokifu-compact@latest
```

想锁定版本就写 `@1.18.5`。升级走的是**装的时候那条来源**：从 npm 装的重解析 npm 的 `latest`；
从 `file:` 装的按那条重解析。

**服务端改动（`src/**`）要重启宿主才生效；`lib/client.js` 改动刷新即可。**
面板报「运行实例版本不一致」时，就是这一条没做。

## 回滚

```bash
# ① 装回旧版本（最快、最常用）
dsh plugin --profile <p> add dsh-gokifu-compact@<旧版本>

# ② 仓库侧：一刀一 commit，所以 git revert 是安全的
git revert <sha>

# ③ 数据侧：只认 .bak-<ts> + sidecar，不手改
ls <DSH_HOME>/chess-context/migrate-backups/    # 迁移/修复脚本的备份都在这里
```

> **回滚不会回滚 `graph.json`**：新版本写过的字段旧版本会当未知字段忽略（一般不致命）。
> 真出问题就先把 `<DSH_HOME>/chess-context/sessions/` **抄一份**再动手 —— 那是唯一的现场。

## 兼容性

插件依赖宿主内部 API（`ctx.compaction` / `ctx.llm` / `ctx.session` / `@deepseek-ai/schemastery`）。
**升级到新的 DSH 内部 API 视为 major**，因为旧宿主可能不再提供同样的服务。
`package.json` 的 `engines.dsh` 是兼容范围的唯一声明（`test/verify-install.mjs` 会拿它过闸）。
