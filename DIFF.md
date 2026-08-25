# DIFF.md — fork 与 upstream 的差异登记簿

本文件只存在于 fork（upstream 没有它，因此永不产生合并冲突），登记本仓库相对 `upstream/master`（`GithubMirror/deepseek-harness`）的全部行为差异：每条差异写明行为、目的、涉及提交与同步注意事项。
维护规则：增删 fork 差异的同一个变更里更新本文件；每次合并 upstream 后核对一遍。
核对命令：`git log --no-merges --format='%h %s' upstream/master..master` —— 输出的每个非合并提交都必须能映射到下表某一条；反过来表中提交如已被 upstream 收编，删除对应条目。

## 总览

| 编号 | 领域 | 一句话 | 关键提交 |
|---|---|---|---|
| [D1](#d1-lan-非安全上下文兼容) | client / apiproxy / llm | 让浏览器经 LAN IP 的 `http://` 访问成为一等公民 | `7e2a93c9c5` `1d03929344` `6c7840ab13` `54b4d5fbf5` `74009195aa` |
| [D2](#d2-特权方法不再限定-loopback) | client-connection | settings/credentials/agentPreset 方法跟随 trusted-host 栅栏而非限死 loopback | `3671721245` `1f638eaa0c` |
| [D3](#d3-per-provider-proxy-与任意-web-host) | llm-pi-ai / web | 每条 provider 路由可选 HTTP(S) 代理；`dsh web` 接受任意 `--host` | `6eafb8e59a` `1f638eaa0c` `8731a9fa42` |
| [D4](#d4-pi-ai-0842-chance0-钉版与-084-适配) | llm-pi-ai | pi-ai 用私服补丁构建并精确钉版，适配 0.84 类型面 | `108dec0913` `528823ee39` `45ba30bf52` |
| [D5](#d5-fork-发版体系) | 全仓库 | `-chance.N` 版本号、Gitea 私服发布、lockfile 对齐策略 | `108dec0913` `45ba30bf52` `74009195aa` `ef6daef5b8` |
| [D6](#d6-upstream-自动同步-workflow) | Gitea | 每 6 小时自动 merge upstream，冲突即显式失败 | `496c1d4bfc` |
| [D7](#d7-本地-cicd-流水线) | Gitea Actions | check/release/生产部署/host 冒烟四条流水线 | `a829ceacaf` 起 |

## D1: LAN 非安全上下文兼容

行为：浏览器通过 `http://<LAN-IP>:308x` 访问时（非安全上下文，`crypto.randomUUID` 不存在）一切功能可用：附件 uuid 走本地 UUIDv4 回退；RPC id 与消息 id 优先 `randomUUID`、缺失时由 `getRandomValues` 构造；被用户取消的请求映射为 `cancelled` 错误码并在历史加载时跳过，不再以红色错误刷屏。
目的：本部署就是 LAN IP + http，不引入 TLS。
提交：`7e2a93c9c5`（browserUuid 回退）、`1d03929344` + `6c7840ab13`（UUID：randomUUID 优先，getRandomValues 兜底——后者修复了绕开 schedule 测试 mock 的回归）、`54b4d5fbf5`（AbortError→cancelled）。
文件：`packages/client/ui-conversation/src/client/service.ts`、`packages/host/apiproxy/src/fetch/client.ts`、`packages/llm/llm/src/message.ts`、`packages/client/runtime/src/client/sessions/session.ts`、`packages/host/apiproxy/src/api/rpc.ts`。
同步注意：`rpc.ts` 是与 upstream 双高热文件（upstream 演进 settings 错误面），合并时逐 hunk 核对；upstream 若自行修复同一问题，删除对应子项。rc.2（540c0cf5bb）upstream 改动了 `service.ts`/`rpc.ts`，合入后 browserUuid 回退与 cancelled 语义已核对仍成立。

## D2: 特权方法不再限定 loopback

行为：`settings.*` / `credentials.*` / `agentPreset.*` RPC 方法不再强制 loopback，改与其他方法一致跟随 `--trusted-host` 栅栏（DNS-rebinding 防御保留）；不可达方法现在答 404 而非 403。
目的：部署在可信 LAN，配置面需要从 LAN 客户端直接可达。
提交：`3671721245`（实现）、`1f638eaa0c`（404 断言测试）。
文件：`packages/client/connection/src/index.ts`、`packages/client/connection/tests/node-half.host.spec.ts`。
同步注意：upstream 未改 `connection/src/index.ts` 时不冲突；若 upstream 重构特权方法表，按"跟随 trusted-host"的语义重放。rc.2（540c0cf5bb）upstream 改动了该文件，合入后特权方法跟随 trusted-host 栅栏已核对仍成立。

## D3: per-provider proxy 与任意 web host

行为：`llm-pi-ai` 的 provider 路由新增 `proxy` 字段（如 `http://<proxy-host>:7890`），设置后该路由每个模型的出站请求经 undici `ProxyAgent` 代理——含 Anthropic Messages 协议（依赖 D4 私服构建的 `model.fetch` 透传）；`dsh web` 接受任意 `--host`（含 `0.0.0.0`）。
目的：`claude.p1.cn` 等端点必须经 LAN clash 代理才可达；服务绑定 LAN。
提交：`6eafb8e59a`（实现）、`1f638eaa0c`（表单断言测试）、`8731a9fa42`（config-catalog 入册）、`3691d75540`（代理注释地址迁移到 <proxy-host>）。
文件：`packages/llm/llm-pi-ai/src/{provider,config}.ts`、`packages/client/ui-settings-models/src/client/{CustomProviderCard,ProviderEditor}.tsx`、`packages/bundle/web-app/src/startup.ts`、`apps/cli`。
同步注意：`proxy` 是 fork 私有配置面；upstream 若引入同名能力以 upstream 为准并重新评估 D4 的 model.fetch 依赖。rc.2（540c0cf5bb）upstream 改动了 `config.ts`/`provider.ts`/`startup.ts`，合入后 proxy 与任意 `--host` 已核对仍成立。

## D4: pi-ai 0.84.2-chance.0 钉版与 0.84 适配

行为：`@earendil-works/pi-ai` 精确钉版私服构建 `0.84.2-chance.0`（原版 0.84.2 + Anthropic 适配器一行 `model.fetch` 透传）；适配层把 0.84 独有 compat 字段（chatTemplateArgs 等 4 个）在上游 disposition gate 中 withhold、`baseten` 进 thinking-format gate（上游双向类型不变式使然）、映射新 `StopReason`（`pending`→TRANSPORT、`deferred`→不支持）、signal 已 abort 时终态 error 重分类为 aborted。
目的：0.84 修复了 Anthropic 网关在 `content_block_start` 携带完整 thinking 块时内容/签名被清零的 bug（p1 路由必需）；钉版防止 `^` 范围解析到同私服上无补丁的原版镜像。
提交：`108dec0913`（钉版+发版）、`528823ee39`（0.84 适配）、`45ba30bf52`（lockfile 策略）。
文件：`packages/llm/llm-pi-ai/src/{catalog,stream,adapter}.ts`、`packages/llm/llm-pi-ai/package.json`。
同步注意：upstream 仍用 `^0.82.1`——每次合并后 lockfile 以 upstream 为基底重建，再重放钉版（见 D5）；upstream 升 0.84 时适配提交变无操作，届时删除本条并入 upstream。0.1.1-rc.1 合入后新增的 `auth.ts`/`login.ts`（按 0.82.1 类型面编写）已在钉版 0.84.2-chance.0 上通过 typecheck（0.84 的 auth 面是 0.82 的超集）；upstream 若改用 0.84 类型面，重新核对此条。

## D5: fork 发版体系

行为：全家族以 `<upstream 版本>-chance.N` 发布到本地 Gitea 私服（`http://<gitea-host>:3000/api/packages/ChanceFlow/npm/`，由 gitignore 的本地 `.npmrc` 指向）；发版时的版本 bump 与 lockfile 同时提交；lockfile 策略为"以 upstream 解析为基底 + fork 增量（pi-ai 钉版、undici）"，避免 dev 依赖漂移；`/dist/`、`/apps/cli/dist/` 为发版 staging 产物，已 gitignore。
目的：内网部署不经公共 npm；fork 版本与 upstream 公开发版同库共存不冲突。
提交：`108dec0913`（rc.6-chance.1）、`74009195aa`/`ef6daef5b8`（热修产物 bump）、`45ba30bf52`（lockfile 对齐 + Agent Note）、`11b77d8f8d`（内网与组织名迁移，含 registry 端点）。
细节：[fork registry 与 pi-ai chance 构建](.agents/notes/implemented/process/2026-08-17-fork-registry-and-pi-ai-chance-builds.md)；用户接入与版本鉴别见 [REGISTRY.md](REGISTRY.md)。
同步注意：版本号冲突（rc.2 实测 230 个 package.json）统一取 upstream，下一次 fork 发版再 `-chance` 化；registry 组织名必须以注册表规范大小写 `ChanceFlow` 书写（Gitea 路由不分大小写，但 pnpm 的 tarball 供应链校验区分大小写，lockfile/workflow 里的小写 `chanceflow` 会被 `[ERR_PNPM_TARBALL_URL_MISMATCH]` 拒绝）；升级生产 = `npm install -g @deepseek-ai/dsh && systemctl --user restart dsh`（见 `~/services/dsh/start.sh`）。

## D6: upstream 自动同步 workflow

行为：Gitea 每 6 小时把 `upstream/master` merge 进 fork 的 `master` 并推送；冲突即失败并要求人工解决。
目的：无人值守跟进 upstream；冲突显式可见而非静默漂移。
提交：`496c1d4bfc`。
文件：`.gitea/workflows/sync-upstream.yml`。
同步注意：本文件与该 workflow 互补——人工解决冲突后按本登记簿核对各差异条目仍然成立。

## D7: 本地 CI/CD 流水线

行为：四条 Gitea Actions 流水线。`check.yml`（master push/PR：typecheck + llm-pi-ai/client-connection 套件 + registry 探针）；`release.yml`（tag `dsh-v*`：构建→打包→发布全家族→latest dist-tag→自动重部署 staging :3081，不碰生产）；`deploy.yml`（`git push origin master:deploy-prod` 即手动生产部署按钮，装 latest 并重启 :3080）；`host-smoke.yml`（`git push origin master:ci-host-smoke` 冒烟 host runner）。
目的：发版与检查全自动；生产部署保留人工门。
运行环境：容器 runner（act_runner 容器，`ubuntu-latest` 标签，job 容器 `node:22-bookworm` + 禁 IPv6 + pnpm store 卷 `~/.cache/ci-pnpm`）+ host runner（`dsh-host` 标签，systemd user 单元 `act-runner-host`，做部署类 job）。job 内 `.npmrc` 现场生成（只含 scope 路由 + token）——宿主 `~/.npmrc` 的 `proxy=http://localhost:7890/` 在容器内指向容器自身，绝不能整文件挂载；runner 配置的 `envs:` 会覆盖 workflow env，故代理类变量全部由 workflow 自管。
提交：`a829ceacaf` 起的 `.gitea/workflows/` 系列。
同步注意：upstream 无这些文件，永不冲突；流水线语义变更时更新本条。release 的 staging 部署会把本仓库检出到 tag 的 detached HEAD——后续开发先 `git checkout master`。workflow 内 git/npm 端点随 `11b77d8f8d` 迁到 `<gitea-host>`/`ChanceFlow`，且 job 内现场生成 `.npmrc` 的 scope 路由必须用规范大小写（见 D5）。
