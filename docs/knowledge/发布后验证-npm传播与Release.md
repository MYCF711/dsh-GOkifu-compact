# 发布后验证：npm 传播与 GitHub Release

> 抓取日期：2026-11-07。**已核实**：本机 1.18.3 发布实测。**待核实**：npm 官方是否有明确传播 SLA。

## 外部资料

| 来源 | 用途 | 状态 |
|---|---|---|
| [npm-view](https://docs.npmjs.com/cli/v11/commands/npm-view) | `npm view <pkg>@<version> version`、`dist-tags`、`dist.tarball` 的只读查询 | 已抓取 HTTP 200；页面正文被截断，命令语义按本机实际输出核对 |
| [GitHub REST API · Releases](https://docs.github.com/en/rest/releases/releases) | `GET /repos/{owner}/{repo}/releases/tags/{tag}`，判断 `draft` / `prerelease` | 已抓取 HTTP 200；API 版本 2026-03-10 |

## 本机实测（1.18.3）

1. `npm publish` 返回 `+ dsh-gokifu-compact@1.18.3`，**exit 0**；
2. 约 1 分钟内 `npm view dsh-gokifu-compact version` 仍是 **1.18.2**，`curl .../1.18.3` 为 **404**；
3. 再等约 90 秒后：`npm view dist-tags --json` 给出 `latest=1.18.3`，`curl .../1.18.3` 为 **200**；
4. 同一时刻 GitHub Release `v1.18.3` 已是 `draft:false / prerelease:false`。

⇒ **`npm publish` 返回 0 不等于用户能装到**。发布脚本必须以 registry 的可查询状态为准，不能以 publish 退出码为准。

## 对插件的落地

`scripts/release-post-verify.mjs` 把五条判据做成只读轮询：

1. `npm view <pkg>@<version> version` 精确等于目标版本（默认 180s / 5s）；
2. `dist-tags.latest` 等于目标版本；
3. tarball 内 `CHANGELOG.md` 含 `## <version>` 段；
4. `verify-release.mjs --tag --tarball` 逐文件一致；
5. 有 token 时 GitHub Release 非 draft/prerelease 且 tag 对。

任一条失败都非零退出，并明确「publish 已完成，不要重跑发布事务」。

## 未核实

- npm 官方对 registry 传播延迟的**明确上限**（SLA）未找到；本机观测约 2 分钟，不能外推为所有包的保证。
- GitHub Release API 的 `name` 字段是否在所有创建路径都等于版本号；当前判据允许 `name` 缺失，只强制 tag/draft/prerelease。
