# 安全策略

## 支持范围

只维护**最新发布版本**（见 [Releases](https://github.com/MYCF711/dsh-GOkifu-compact/releases)）。
旧版本的问题请先升级再确认 —— 本仓发版很密，1.17 之前的问题基本都已修过。

## 怎么报告漏洞

**不要开公开 issue。** 用下面任一私密渠道：

1. GitHub 私密漏洞报告：仓库页 **Security → Report a vulnerability**（推荐，自动带上上下文）；
2. 或发邮件到仓库维护者邮箱（见 `package.json` 的 `author` 字段）。

请在报告里写清：

- 影响的版本与宿主版本（面板「状态」卡或 `package.json`）；
- 复现步骤（能贴最小脚本最好）；
- 你判断的严重程度（凭证泄漏 / 提权 / 拒绝服务 / 仅信息暴露）。

**48 小时内**会给第一次回复（只是确认收到，不代表已修复）。

## 本插件的安全模型（知道这些能少走弯路）

| 面 | 我们的做法 |
|---|---|
| **网络面** | **零**。插件不监 listening socket、不发任何出站 HTTP。唯一的网络动作是**调用宿主注入的摘要模型**（`ctx.llm`），走宿主自己的路由与凭证 |
| **依赖** | **零运行时依赖**。`package.json` 的 `dependencies` / `devDependencies` 都是空对象；`peerDependencies` 里的 `@deepseek-ai/*` 由宿主提供，不装、不发。供应链面 = 本仓自己的 `src/` + `scripts/` |
| **凭证** | **凭证不经过模型，也不经过本插件**。插件不读 `~/.gh`、不读 keyring、不读任何 token 文件；摘要调用用宿主给的句柄。落盘的 `graph.json` / `graph.json.delta.jsonl` 里**没有凭证字段** |
| **模型可见文本** | 热清单只陈述**会话事实**（根目标 / 约束 / 成功路径 / 失败边原文）。**不许**出现行动指导、认知指令、工具治理开关 —— 由 `node scripts/boundary-audit.mjs` 的 6 条规则机器看守，0 条才算过 |
| **路径** | 模型可见文本里**不出现本机绝对路径**：一律相对化为 `sessions/<sid>/graph.json`、`nodes/<n>.md`（Windows 反斜杠曾让掩码整段漏出，已修） |
| **写入面** | 只写 `<DSH_HOME>/chess-context/`（棋谱与树）。**不写**用户仓库、**不写** `profiles/*/cordis.patch.yml`（那是安装器的活，且有备份与回滚） |
| **执行面** | 插件**不执行**用户输入。唯一的子进程调用在 `scripts/` 下的诊断脚本里，且都是 `node` / `npm` 白名单命令 |

## 已知的边界

- **依赖宿主内部 API**（`ctx.compaction` / `ctx.llm` / `ctx.session` / `@deepseek-ai/schemastery`）。
  宿主版本不匹配时可能整体不挂载 —— 那是**兼容性**问题，按普通 issue 报即可，不用走私密渠道。
- **`graph.json` 是明文**：里面是会话目标、约束、工具报错原文。**它包含你的会话内容**，
  分享前请自行脱敏（本仓的 `privacy-audit` 只保证**我们自己**不往仓库里写这些）。
- **`graph.json` 落后一个回合**（增量落盘）：外部工具直接 `JSON.parse` 当「最新」会少一回合数据。
  这是设计选择，不是缺陷；正确的读法见 [README](README.md) 的「棋谱落盘」一节。

## 不构成漏洞的情况

- 需要本机管理员权限才能触发的行为；
- 你自己把 `graph.json` 贴到公开 issue 里（那是你的操作，不是泄漏）；
- 宿主自身的漏洞（请报给 DSH 上游）；
- 摘要模型输出了幻觉 id（这是**质量**问题：C458 起会在 `summarize` 里机械换成 `n?` / `e?`，
  由 `foldMark.sanitizedIds` 计数。要报请走质量 issue，不要当安全漏洞）。
