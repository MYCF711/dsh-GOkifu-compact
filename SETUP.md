# SETUP：把棋谱压缩装进当前 DSH

> 给 coding agent：陪操作者把 `dsh-gokifu-compact` 装进当前 DSH profile，并确认它**真的接管了压缩**。
> 操作者只需对自己的 agent 说：「读仓库根目录的 SETUP.md，按它带我安装棋谱压缩。」

## 0 · 纪律

- 收齐全部答案前，只读 [README](README.md) 与 [QUICKSTART](QUICKSTART.md)；除下面的只读探测外不读别的文件、不改配置。
- 一条消息只问一个短问题，等回答再问下一题；每题给推荐答案和一句理由。上下文已经明确回答的题跳过。
- 提问期间**不执行安装**。收齐全部答案后，一次给出完整计划；操作者明确确认后才执行。
- 密钥永远不在聊天里索要 —— 本插件**不需要任何密钥**（它不联网、不读凭证，见 [SECURITY.md](SECURITY.md)）。
- **不重启、不关闭 DSH**：安装后由操作者在方便时自己重启（铁律）。你只负责说清「为什么必须重启」。

## 1 · 只读探测

在仓库目录运行一次；逐项记录结果，缺失项进入计划，不变成追加问题：

```bash
node --version                                   # 需要 >= 20
node -p "require('./package.json').version"      # 期望 1.18.5
node -p "JSON.stringify(require('./package.json').engines)"   # {'node':'>=20','dsh':'^0.2.0-rc.2'}
printf 'DSH_PROFILE=%s\nDSH_HOME=%s\n' "${DSH_PROFILE-}" "${DSH_HOME-}"
```

再跑一次**安装前体检**（只读，`DSH_HOME` 不写）：

```bash
npx dsh-gokifu-compact doctor
```

它会给四件事：**装没装上**、**摘要模型能不能解析**、**最近的压缩成功/失败**、**棋谱与树健不健康**。
其中「运行实例版本」一项如果报 buildId 不一致，说明跑的是旧构建 —— **那是现状，不是错误**，
记进计划的「重启后要复查」里。

## 2 · 一次一问

按顺序问以下四项。引号内是可改写的短模板，不要合并成问卷。

1. **装到哪个 profile**
   「装到哪个 profile？推荐：`desktop`（本机默认）。`--profile` 是**必填**的 —— 不传就没有 profile 可解析。
   如果目标是 `desktop`，命令**必须**用 Desktop 自带的 CLI 包装器（`<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`），
   PATH 里的普通 `dsh` 二进制会以 `profile desktop is managed exclusively by the Electron application` 直接拒绝。」
2. **装哪个版本**
   「装最新稳定版吗？推荐：`@latest`（当前 1.18.5）。想锁定就写 `@1.18.5`。」
3. **要不要清掉旧 preset**
   「之前装过 1.15.x 的 `dsh-gokifu-preset` 吗？推荐：先 `dsh plugin --profile <p> remove dsh-gokifu-preset`。
   `dsh-gokifu-preset` 和本包**不是**二选一的关系 —— 两个都装会让同名 preset 重复注册。」
4. **第三方 preset 怎么处理**
   「你装过别的带 preset 的插件（例如 `dsh-design-studio`）吗？推荐：**只登记不覆盖**。
   强覆盖别人的 preset 属于越权，而且会被对方升级冲掉；`doctor` 的『第三方 preset 的压缩后端』会点名是哪个。」

## 3 · 收齐后给完整计划

用一条消息列全以下内容，末尾只问「按此计划执行吗？」：

- **安装**：目标 profile + 版本，执行 `dsh plugin --profile <profile> add dsh-gokifu-compact`。
- **等价的图形入口**：桌面版最省事是 **插件市场 → 安装**（点一下），不需要命令行。
- **清理**：如果操作者确认装过 `dsh-gokifu-preset`，先 remove 再装。
- **为什么必须重启**：`cordis.patch.yml` 是 **bundle 层**，只在**启动时**合并进 `dsh.profile.bundles`。
  ⇒ 装完不重启 = 什么都没发生（**这是最常见的一句「装完没反应」**）。
- **写入与回滚**：安装器会给 `profiles/<name>/cordis.patch.yml` 与 `profiles/<name>/package.json` 各留一份
  `.bak-before-chess-context-<ts>` 备份；回滚见 [UPDATING.md](UPDATING.md)。
- **验收**：下列第 5 节全部步骤。

计划未获明确确认前，不执行任何 `add` / `remove`。

## 4 · 确认后执行

1. **先做操作者步骤**（清旧 preset、确认 profile 名）。
2. **装进当前 profile**（把占位符换成已确认值）：

   ```bash
   dsh plugin --profile <profile> add dsh-gokifu-compact
   ```

   不用 `npm i` 代替 profile 安装 —— `npm i` 只会下载到本地 `node_modules`，
   宿主**不会**加载它（包里的 `dsh.bundle.patch` 要由 profile 的安装流程来读）。
3. **请操作者自己重启 DSH**（你不执行、也不建议用 `taskkill` 之类的粗暴手段）。
4. 任一步失败就报告原文；只修复已确认计划内的原因，新增外部写入先回到计划确认。

## 5 · 安装后验收

**重启之后**按顺序做，每步都有期望输出：

| 顺序 | 动作 | 通过标准 |
|---|---|---|
| 1 | `npx dsh-gokifu-compact doctor` | 四项里「装没装上」为 ✓；「运行实例版本」的 buildId 与磁盘一致（不一致 = 还没重启成功） |
| 2 | `node scripts/post-restart-check.mjs` | 全 ✓：buildId 一致 + 归因字段出现 + doctor 0 错 + boundary 0 条 |
| 3 | `dsh --profile <p> --dump-config \| grep -E "^- id: preset-\|gokifu-compact/engine"` | `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 四行都出现，且每行下面各有一个 `name: dsh-gokifu-compact/engine` |
| 4 | 随便选一个模式发一条消息 | `<DSH_HOME>/chess-context/sessions/<id>/graph.json` 出现，且 `nodes` / `edges` 都 > 0 —— **官方压缩不会产生这个目录** |
| 5 | 让 agent 做点带工具调用的事 | 它的 system 消息里出现 `<chess-ledger>`（根目标 / 约束 / 失败边） |

第 3 步出现「只覆盖了部分 preset」⇒ 宿主版本变了（preset 文件形状变了），
重跑 `node scripts/make-presets-override.mjs` 看哪一步报错（生成器有自检，不会产出坏文件）。

第 3 步一个都没有 ⇒ 本包没进 `dsh.profile.bundles`，或 profile 里还留着旧的手工行（两条通道只能二选一）。

最后交付：profile 名、版本、面板所见、四行 preset 的输出、首个 `graph.json` 的路径，以及回滚命令。

## 6 · 装错了怎么退回

见 [UPDATING.md](UPDATING.md) 的「回滚」一节。最短路径：

```bash
dsh plugin --profile <p> add dsh-gokifu-compact@1.17.6   # 换成想回到的版本
```

`<DSH_HOME>/chess-context/` 下的图数据**不会**被卸载删除，重新装回来还能接着用
（想真的清干净再手动删，见 [README](README.md) 的「卸载与回滚」）。
