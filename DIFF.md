# DIFF.md — fork 与 upstream 的差异登记簿

本文件只存在于 fork（upstream 没有它，因此永不产生合并冲突），登记本仓库相对 `upstream/master`（`GithubMirror/deepseek-harness`）的全部行为差异：每条差异写明行为、目的、涉及提交与同步注意事项。
文中 `<gitea-host>`、`<gitea-legacy-host>`、`<proxy-host>`、`<user>` 是脱敏占位符，真实值在内网运维配置中，不入库；"关键提交"的短哈希在 Gitea 源仓库可解析，GitHub 镜像经 push-to-github 流水线脱敏重写后哈希不同。
维护规则：增删 fork 差异的同一个变更里更新本文件；每次合并 upstream 后核对一遍。
核对命令：`git log --no-merges --format='%h %s' upstream/master..master` —— 输出的每个非合并提交都必须能映射到下表某一条；反过来表中提交如已被 upstream 收编，删除对应条目。

## 总览

| 编号 | 领域 | 一句话 | 关键提交 |
|---|---|---|---|
| [D1](#d1-lan-非安全上下文兼容) | client / apiproxy / llm | 让浏览器经 LAN IP 的 `http://` 访问成为一等公民 | `7e2a93c9c5` `1d03929344` `6c7840ab13` `54b4d5fbf5` `74009195aa` |
| [D2](#d2-特权方法不再限定-loopback) | client-connection | settings/credentials/agentPreset 方法跟随 trusted-host 栅栏而非限死 loopback | `3671721245` `1f638eaa0c` |
| [D3](#d3-任意-web-host) | web | `dsh web` 接受任意 `--host`（含 `0.0.0.0`）与局域网 Host 白名单 | `6eafb8e59a` `1f638eaa0c` `8731a9fa42` |
| [D4](#d4-已退役-pi-ai-chance-私服构建) | llm-pi-ai | 已退役：proxy 移除后切回官方原版 `^0.85.1` | `108dec0913` `528823ee39` `45ba30bf52` |
| [D5](#d5-fork-发版体系) | 全仓库 | `-chance.N` 版本号、Gitea 私服发布、lockfile 对齐策略 | `108dec0913` `45ba30bf52` `74009195aa` `ef6daef5b8` |
| [D6](#d6-upstream-自动同步-workflow) | Gitea | 每 6 小时自动 merge upstream，冲突即显式失败 | `496c1d4bfc` |
| [D7](#d7-本地-cicd-流水线) | Gitea Actions | check/release/生产部署/host 冒烟四条流水线 | `a829ceacaf` 起 |
| [D8](#d8-别名-answer-按请求模型回放) | llm-pi-ai | 别名作答的 Anthropic 轮次按请求模型身份回放，保住 thinking 回传 | 待填（chance.2） |

## D1: LAN 非安全上下文兼容

行为：浏览器通过 `http://<LAN-IP>:308x` 访问时（非安全上下文，`crypto.randomUUID` 不存在）一切功能可用：附件 uuid 走本地 UUIDv4 回退；RPC id 与消息 id 优先 `randomUUID`、缺失时由 `getRandomValues` 构造；被用户取消的请求映射为 `cancelled` 错误码并在历史加载时跳过，不再以红色错误刷屏。
目的：本部署就是 LAN IP + http，不引入 TLS。
提交：`7e2a93c9c5`（browserUuid 回退）、`1d03929344` + `6c7840ab13`（UUID：randomUUID 优先，getRandomValues 兜底——后者修复了绕开 schedule 测试 mock 的回归）、`54b4d5fbf5`（AbortError→cancelled）。
文件：`packages/client/ui-conversation/src/client/service.ts`、`packages/host/apiproxy/src/fetch/client.ts`、`packages/llm/llm/src/message.ts`、`packages/client/runtime/src/client/sessions/session.ts`、`packages/host/apiproxy/src/api/rpc.ts`。
同步注意：`rpc.ts` 是与 upstream 双高热文件（upstream 演进 settings 错误面），合并时逐 hunk 核对；upstream 若自行修复同一问题，删除对应子项。rc.2（540c0cf5bb）upstream 改动了 `service.ts`/`rpc.ts`，合入后 browserUuid 回退与 cancelled 语义已核对仍成立。0.1.2-rc.1 合入：upstream 官方引入 `@deepseek-ai/dsh-util-crypto` 并落地全仓 lint 规则，统一解决非安全上下文 UUID 问题；`apiproxy` 与 `client-runtime` 已被 upstream 重构解耦，browserUuid 与旧 rpc.ts 子项并入 upstream。0.1.5-rc.2 合入：upstream 重构 `ClientTransportHooks`（新增 `rpc?`、`fetch` 变为可选），与本条 `isLanHostname` 落在同一文件的不同 hunk，git 自动合并无冲突；合入后已复核 LAN 主机名仍计入 `isLoopback`。

## D2: 特权方法不再限定 loopback

行为：`settings.*` / `credentials.*` / `agentPreset.*` RPC 方法不再强制 loopback，改与其他方法一致跟随 `--trusted-host` 栅栏（DNS-rebinding 防御保留）；不可达方法现在答 404 而非 403。
目的：部署在可信 LAN，配置面需要从 LAN 客户端直接可达。
提交：`3671721245`（实现）、`1f638eaa0c`（404 断言测试）。
文件：`packages/client/connection/src/index.ts`、`packages/client/connection/tests/node-half.host.spec.ts`。
同步注意：upstream 未改 `connection/src/index.ts` 时不冲突；若 upstream 重构特权方法表，按"跟随 trusted-host"的语义重放。rc.2（540c0cf5bb）upstream 改动了该文件，合入后特权方法跟随 trusted-host 栅栏已核对仍成立。0.1.2-rc.1 合入：upstream 官方以 `BrowserAuth` Cookie 统一全部 RPC 方法鉴权，彻底移除了特权方法仅限 loopback 的旧限制，D2 已被 upstream 完全吸收。

## D3: 任意 web host

行为：`dsh web` 接受任意 `--host`（含 `0.0.0.0`），且局域网 IP / `.local` 访问通过 `isLanHostname` 校验纳入可信访问。此前曾附带 per-provider proxy 特性，现已随 EasyTier 直连调通而退役清理，仅保留 Web host 绑定与 LAN 访问支持。
目的：服务需要绑定 LAN 供局域网设备直接访问。
提交：`6eafb8e59a`（host 实现）、`1f638eaa0c`（测试）。
文件：`packages/bundle/web-app/src/startup.ts`、`packages/client/connection/src/loopback-hostname.ts`、`apps/cli`。
同步注意：合并时核对 `--host 0.0.0.0` 拦截移除与 `isLanHostname` 仍成立。

## D4: (已退役) pi-ai chance 私服构建

行为：已退役销账。此前因 per-provider `proxy` 需求曾钉版私服构建 `0.85.1-chance.0`（补丁一行 `model.fetch`），在确认 EasyTier VPN 下所有节点均可裸连 `claude.p1.cn`、且全局 env 代理已由上游 `dsh-http-proxy` 统一接管后，代码全面移除 `proxy` 字段，依赖已完全切回官方原版 `^0.85.1`。不再需要私服单独打包与维护 chance 构建。
目的：消除外部私服依赖分支，保持与 upstream 依赖一致。
文件：`packages/llm/llm-pi-ai/package.json`。
同步注意：保持官方 `^0.85.1`，后续随 upstream 自动升级，无需再维护 patch。私服上 `@earendil-works/pi-ai` 的 `latest` dist-tag 曾被留在 `0.85.1-chance.0`，已改指最新镜像的公共发布 `0.86.1`；Gitea 不支持 `npm deprecate`，退役构建仍列在版本表但 `latest` 与公共版本范围都到不了它。

## D5: fork 发版体系

行为：全家族以 `<upstream 版本>-chance.N` 发布到本地 Gitea 私服（`http://<gitea-host>:3000/api/packages/ChanceFlow/npm/`，由 gitignore 的本地 `.npmrc` 指向）；发版时的版本 bump 与 lockfile 同时提交；lockfile 策略为"以 upstream 解析为基底 + fork 增量（pi-ai 钉版、undici）"，避免 dev 依赖漂移；`/dist/`、`/apps/cli/dist/` 为发版 staging 产物，已 gitignore；`native/system` 序列不在 fork 内构建——`pnpm run release:mirror-native` 把 checkout 钉住的 `@deepseek-ai/node-addon-system` 版本从公共 registry 镜像进私服（平台包先于入口包；公共 tarball 的字节必须与公共 registry 记录的 integrity 一致，私服已有版本也必须记录同一 integrity），release workflow 在打包前自动执行，取代此前的手工镜像。
目的：内网部署不经公共 npm；fork 版本与 upstream 公开发版同库共存不冲突；四个 dsh 包依赖的 native addon 随每次发版自动到位，不再依赖人工记忆。
提交：`108dec0913`（rc.6-chance.1）、`74009195aa`/`ef6daef5b8`（热修产物 bump）、`45ba30bf52`（lockfile 对齐 + Agent Note）、`11b77d8f8d`（内网与组织名迁移，含 registry 端点）、`a87175f078`（native 镜像步骤）。
文件：`scripts/release/{registry,mirror-native}.ts`、`scripts/release/mirror-native.spec.ts`、`.gitea/workflows/release.yml`。
细节：[fork registry 与 pi-ai chance 构建](.agents/notes/implemented/process/2026-08-17-fork-registry-and-pi-ai-chance-builds.md)；用户接入与版本鉴别见 [REGISTRY.md](REGISTRY.md)。
同步注意：版本号冲突（rc.2 实测 230 个 package.json）统一取 upstream，下一次 fork 发版再 `-chance` 化；registry 组织名必须以注册表规范大小写 `ChanceFlow` 书写（Gitea 路由不分大小写，但 pnpm 的 tarball 供应链校验区分大小写，lockfile/workflow 里的小写 `chanceflow` 会被 `[ERR_PNPM_TARBALL_URL_MISMATCH]` 拒绝）；升级生产 = `npm install -g @deepseek-ai/dsh && systemctl --user restart dsh`（见 `~/services/dsh/start.sh`）；镜像脚本按 `native/system/packages/*`（`prebuilds.json` 标记平台包）自动跟随 upstream 的改名与新增，但 checkout 钉住的 native 版本若 upstream 尚未发布，release 会在镜像步骤失败并报出版本号，此时应等 upstream 发布或用 `--source` 指定实际承载该版本的 registry。0.1.5-rc.2 合入：272 个 `package.json` 的版本冲突统一取 upstream `0.1.5-rc.2`，无源码冲突；自动合并的 `pnpm-lock.yaml` 经 `pnpm install` 校验无需再对齐。

## D6: upstream 自动同步 workflow

行为：Gitea 每 6 小时把 `upstream/master` merge 进 fork 的 `master` 并推送；冲突即失败并要求人工解决。
目的：无人值守跟进 upstream；冲突显式可见而非静默漂移。
提交：`496c1d4bfc`。
文件：`.gitea/workflows/sync-upstream.yml`。
同步注意：本文件与该 workflow 互补——人工解决冲突后按本登记簿核对各差异条目仍然成立。

## D7: 本地 CI/CD 流水线

行为：四条 Gitea Actions 流水线。`check.yml`（master push/PR：typecheck + llm-pi-ai/client-connection 套件 + registry 探针）；`release.yml`（tag `dsh-v*`：构建→镜像 native 包（`release:mirror-native`，见 D5）→打包→发布全家族→latest dist-tag→自动重部署 staging :3081，不碰生产）；`deploy.yml`（`git push origin master:deploy-prod` 即手动生产部署按钮，装 latest 并重启 :3080）；`host-smoke.yml`（`git push origin master:ci-host-smoke` 冒烟 host runner）。
目的：发版与检查全自动；生产部署保留人工门。
运行环境：容器 runner（act_runner 容器，`ubuntu-latest` 标签，job 容器 `node:22-bookworm` + 禁 IPv6 + pnpm store 卷 `~/.cache/ci-pnpm`）+ host runner（`dsh-host` 标签，systemd user 单元 `act-runner-host`，做部署类 job）。job 内 `.npmrc` 现场生成（只含 scope 路由 + token）——宿主 `~/.npmrc` 的 `proxy=http://localhost:7890/` 在容器内指向容器自身，绝不能整文件挂载；runner 配置的 `envs:` 会覆盖 workflow env，故代理类变量全部由 workflow 自管。
提交：`a829ceacaf` 起的 `.gitea/workflows/` 系列（`a87175f078` 为 release 加入 native 镜像步骤）。
同步注意：upstream 无这些文件，永不冲突；流水线语义变更时更新本条。release 的 staging 部署会把本仓库检出到 tag 的 detached HEAD——后续开发先 `git checkout master`。workflow 内 git/npm 端点随 `11b77d8f8d` 迁到 `<gitea-host>`/`ChanceFlow`，且 job 内现场生成 `.npmrc` 的 scope 路由必须用规范大小写（见 D5）。发布脚本必须经 `pnpm run release:*` 调用（不能 `pnpm exec tsx scripts/release/*.ts`），否则 `npm_execpath` 缺失会让 `scripts/pnpm-invocation.ts` 直接报错；经 `pnpm run` 时选项直接跟脚本名，不要多余的 `--`。

## D8: 别名 answer 按请求模型回放

行为：`packages/llm/llm-pi-ai/src/replay.ts` 的 `replayedAssistant` 用请求模型 id（`response.model`）设置回放 assistant 消息的 `model`，把端点上报的别名留在 `responseModel`（仅信息用途）。pi-ai 的 `transformMessages` 以 `assistantMsg.model === model.id` 判定同模型续写；此前 fork 与 upstream 都把别名恢复成 `model`，导致别名作答（p1 网关的 `deepseek-v4-1-flash-260910`、Anthropic 日期别名/fallback）被读成外来历史，thinking 块被降级为 text，网关随即报 `The content[].thinking in the thinking mode must be passed back to the API.`。
目的：p1 网关的 thinking 必须原样回传；该故障间歇出现（报告别名的那条后端路径必失败，报告请求 id 的路径正常），且 `compat.allowEmptySignature` 无法覆盖（该开关在同模型分支之后才生效）。
提交：本次 chance.2 提交。
文件：`packages/llm/llm-pi-ai/src/replay.ts`、`packages/llm/llm-pi-ai/tests/convert.spec.ts`、`.agents/notes/implemented/bug-fix/2026-09-20-pi-ai-alias-thinking-replay.md`。
同步注意：这是 upstream 尚未修复的缺陷，合并 upstream 时若其 `replay.ts` 仍把 `responseModel` 当身份恢复，需重放本差异；若 upstream 自行修复，删除本条并核对 `convert.spec.ts` 断言方向。该注部分取代 [pi-ai 升级兼容性](.agents/notes/implemented/bug-fix/2026-09-05-pi-ai-upgrade-compatibility.md) 的回放来源段落，两处已互相链接。

## D9: 缺失 thinking 的工具调用轮次补空块

行为：`packages/llm/llm-pi-ai/src/replay.ts` 的 `toPiAssistant` 在路由声明 `compat.allowEmptySignature` 时维持回传不变量——被重放且含工具调用的 assistant 轮次必须携带 thinking 块。持久轮次没有记录 reasoning 时前置 `{type:'thinking', thinking:'', thinkingSignature:'dsh-synthetic-thinking'}`；只记录了一个文本为空且无签名的 thinking 块时补上同一占位签名。块文本始终为空，模型可见内容没有增加。
目的：p1 网关在 thinking 模式下要求每条含 `tool_use` 的 assistant 消息回传 thinking（实测：缺块 400；空文本或缺签名的块 200；纯文本轮次不需要）。provider 有时根本不返回 reasoning（重放已部署子 agent 的请求形态，10/10 没有 thinking 内容块），跨 provider 会话里的 Gemini 轮次又把 thinking 放在 `thoughtSignature` 而 pi-ai 转换时会丢弃；这两种形态都无法用 pi-ai 自身开关修好。删除 `thinking` 请求字段同样无效——端点默认 thinking 开启，只有显式 `{"type":"disabled"}` 才关闭该模式。
提交：本次提交。
文件：`packages/llm/llm-pi-ai/src/replay.ts`、`packages/llm/llm-pi-ai/src/context.ts`、`packages/llm/llm-pi-ai/src/adapter.ts`、`packages/llm/llm-pi-ai/tests/convert.spec.ts`、`.agents/notes/implemented/bug-fix/2026-09-21-pi-ai-held-thinking-on-tool-calls.md`。
同步注意：upstream 未修（0.86.1 的两处守卫未变）。合并时若 upstream 的 `transform-messages`/`anthropic-messages` 已能保留空 thinking 块，可删除本条并让 `holdThinkingOnToolCalls` 只保留 pi-ai 仍未覆盖的部分。`allowEmptySignature` 既是 pi-ai 的保留开关，也是本行为的触发条件，改其语义需同时核对两处。跨 provider 轮次仍不在覆盖内：pi-ai 会拍平外来消息上的空 thinking 块，因此混 provider 历史的请求仍可能被拒。
