# Agent Note: Fork 私服发版与 pi-ai chance 构建

Status: implemented

[English](2026-08-17-fork-registry-and-pi-ai-chance-builds.md) | 中文

## 问题

本 checkout 是部署在内网的私有 fork，其 npm registry 是一个 Gitea 包仓库（`http://<gitea-host>:3000/api/packages/ChanceFlow/npm/`）。根目录 `.npmrc`——按设计被 gitignore——把 `@deepseek-ai` 与 `@earendil-works` 两个 scope 指向该私服，安装因此不依赖公共 npm 的可达性。fork 在 upstream 版本号后追加 `-chance.N` 后缀发布自己的版本（`0.1.0-rc.6-chance.1`），而 upstream 的公开发版（`0.1.0-rc.7`）以 `next` dist-tag 并存于同一私服。

这个布局有两个事实单看仓库看不出来，而 2026-08-17 的发版状态又没提交，导致后来的会话只能靠取证式 diff 重新发现它们。其一，私服上除 fork 打过补丁的 `-chance` 重建版外，还镜像了公共 pi-ai 的原版发布（`0.82.1`、`0.84.1`、`0.84.2`、`0.85.1`、`0.86.1`）。其二，fork 的 `dsh-llm-pi-ai` 曾依赖一个任何 upstream 版本都没有的 pi-ai 能力：Anthropic 适配器认 per-model `model.fetch`，per-provider `proxy` 路由字段需要它。两者均已退役；该依赖现在是一个公共版本范围。

## 决策

### pi-ai 走镜像，不本地构建

私服逐字镜像了本 checkout 消费的公共 pi-ai 发布（`0.82.1`、`0.84.1`、`0.84.2`、`0.85.1`、`0.86.1`），每个都与公共 registry 记录的 integrity 核对过，因此内网机器无需公共 npm 即可安装 pi-ai。`dsh-llm-pi-ai` 以 caret 范围依赖公共线（`^0.85.1`），fork 不再对 pi-ai 打任何补丁。

0.82.1 → 0.84.1 那次升级所对应的 Anthropic 流式修复，仍然是依赖不能更旧的原因：0.82.1 在 `content_block_start` 上硬编码 `thinking: ""` 与 `thinkingSignature: ""`，凡是把完整 thinking 块直接放在块起始事件里的网关，推理内容和签名都会被整体丢弃，而 0.84.1 起改读事件自带的字段。

Anthropic 适配器里那一行 `model.fetch` 透传只为 per-route `proxy` 字段存在，而 0.84.1 的 `options.fetch` 参数早已取代了它所需要的 per-model fetch。proxy 字段、它的 `undici` 依赖与 `0.85.1-chance.0` 构建一同退役，早于该构建的 pnpm `patchedDependencies` 条目也一样。

需要精确钉版的 pi-ai `-chance` 重建版保持退役：semver 把 release 排在 prerelease 之前，`^0.85.1-chance.0` 同样匹配同一私服上未打补丁的 `0.85.1` 镜像，全新安装会无声解析到没有透传的构建。fork 自己的 `-chance` 发版继续精确钉版；pi-ai 依赖则是公共版本范围。

私服上 `@earendil-works/pi-ai` 的 `latest` dist-tag 曾被留在 `0.85.1-chance.0`，于是任何 `latest` 解析——`npm i @earendil-works/pi-ai`，或任何允许 prerelease 的依赖范围——都会装上 fork 的私有构建。现在它指向最新的公共镜像发布（`0.86.1`）；Gitea 的 npm registry 不支持 `npm deprecate`，因此该退役构建仍列在版本表中，但 `latest` 与公共版本范围都到不了它。该依赖存在所服务的行为记录在 [为 provider 未给出签名的工具调用轮次保留 thinking 块](../bug-fix/2026-09-21-pi-ai-held-thinking-on-tool-calls.zh.md)。

### fork 发版状态在发布时提交

全家桶 `-chance.N` 版本号 bump 在发布时一并提交（staging tarball 落在 `dist/npm-chance-N/`，现已 gitignore，私服同时以 `latest` 提供同一版本）。除此之外仓库版本号跟随 upstream 的[三条独立发布序列](2026-08-10-npm-release-sequences.zh.md)；upstream `0.1.0-rc.7` 之后的下一个 fork 版本是 `0.1.0-rc.7-chance.0`。Gitea 的 `sync-upstream` workflow 每 6 小时把 `upstream/master` 合入 fork 的 `master`，冲突即显式失败，因此冲突同步由人工一次性解决——2026-08-17 对 upstream rc.6/rc.7 窗口的合并就是一次这样的解决。

### 钉住的公共 @deepseek-ai 包走镜像而非本地构建

`native/system/packages/*` 是 upstream 的第三条发布序列，而四个 dsh 包依赖它的入口包 `@deepseek-ai/node-addon-system`。fork 的 `.npmrc` 把 `@deepseek-ai` 指向私服，因此 fork 发版必须让该版本先落到私服——但 fork 自己造不出来：`native/system` 每个平台各需一个 runner，其中还有 macOS 与 musl 工具链，这正是 upstream 自己的 `Node Addon System Release` workflow 存在的理由。

upstream 还会钉住 fork 从不 vendor 的公共 `@deepseek-ai` 包——`@deepseek-ai/libreoffice-kit` 及其平台包随 0.1.7-rc.2 一起进来——它们的要求相同：`pnpm install --frozen-lockfile` 经由被路由的 scope 解析它们，私服缺任何一个都会让安装在镜像步骤之前就失败。

`scripts/release/mirror-packages.ts` 因此把两个来源钉住的每个版本都镜像过来，而不本地构建或 vendor，release workflow 在打包前运行它。native 包按 upstream 打包步骤的同一套约定读取——带 `prebuilds.json` 的是平台包，平台包先于可选依赖它们的入口包上传；公共依赖取自 `pnpm-lock.yaml`，其 `packages` 段记录 `--frozen-lockfile` 校验的 integrity，`snapshots` 段提供同样的"被依赖者优先"顺序。随后每个包都在两个 registry 上分别判定：取到的 tarball 哈希必须等于它钉住来源记录的 integrity，私服要么没有该版本（此时把取到的字节发布上去），要么记录的 integrity 相同（此时跳过该版本）。钉住而 upstream 从未发布的版本会让这一步失败并报出版本号；私服上与钉住 payload 内容不同的副本同样失败。指定源 registry 时还必须同时覆盖 scope registry，因为 `@deepseek-ai:registry` 的优先级高于 `--registry`：否则"源"读取会落回私服，比对变成私服与自己比对。

### dsh-llm-pi-ai 的 0.84 适配面

pi-ai 0.84 独有的 compat 字段（`chatTemplateArgs`、`supportsFinishReason`、`supportsThinkingTokenBudget`、`supportsAdditionalTools`）在上游的 disposition gate 中保持 withhold，直到上游自己的 pi-ai 升级对它们分类；`baseten` 则留在 thinking-format gate 里：上游 rc.8 的双向 profile 字段检查要求 offered 字段与上游联合类型完全一致，退出一个联合成员等于改写上游的安全不变式，而带着未配置的 `chatTemplateArgs` 命名 baseten 是更小的分歧。新的 `StopReason` 成员都有显式映射：`pending` 是传输截断——是[扁平化消息截断分类](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md)里的又一种措辞——`deferred` 是不支持完成模式。调用方 signal 已 abort 时，终态 `error` 会被重新归类为 `aborted`：pi-ai 0.84 在鉴权解析里加了 `throwIfAborted()`，惰性 setup 包装器把这个 abort 变成了通用的 setup 错误事件，而同一 abort 发生在流中时 pi-ai 自己仍归类为 `aborted`。0.84 目录给 `deepseek-v4-flash` 增加了 `low` 档，并把 `maxTokensField` 定为 `max_tokens`。

## 考虑过的替代方案

**继续用 pnpm `patchedDependencies` 给 pi-ai 打补丁。** 补丁放在 git 里、不惧私服故障，但它与私服预打补丁的构建并存了两周并发生了漂移——私服上的 `0.82.1` 是打过补丁的重发布，而 lockfile 的 integrity 却钉着公共原版 tarball，哪套机制生效取决于安装顺序。只留私服构建这一套机制，消除了这类事故。

**只往私服发 `-chance` 构建并保留 caret 范围。** 撤掉原版 `0.85.1` 镜像后 `^0.85.1-chance.0` 会解析到打补丁的构建，但镜像正是内网机器不需要公共 npm 就能装 pi-ai 的依靠，而且「私服内容不变式」比 `package.json` 里的精确钉版更难被看见。钉版是更小、就在仓库里的事实。

**在 `-chance` 构建内部修 setup-abort 误分类（补惰性包装器）。** 包装器的 catch 拿不到 signal，补丁得把 signal 穿进 setup 闭包；upstream 也可能自己重新归类 setup abort。适配器持有调用方 signal，且本来就在跟随 pi-ai 自己的流中裁决（signal 已 abort 胜过竞态的 provider 错误），因此重映射放在 `adapter.ts`，`-chance` 的差异保持一行。

## 后果

内网私服的安装不需要任何安装期补丁，pi-ai 以未修改的公共发布到达每台机器，因此 fork 不再每次升级都重建私有 pi-ai 构建：pi-ai 依赖是镜像公共版本的 caret 范围，而 fork 自己的发版继续精确钉版 `-chance`。upstream 将来采用这些面时会撞上 `baseten`/`StopReason`/abort 这些适配，届时作为无操作解决；类型级漂移门禁（`THINKING_FORMAT_GATE`、`mapStopReason` 的 switch）会在下一次 pi-ai 面变化时按设计跳闸。

镜像让 `native/system` 保持为 fork 从不构建的 upstream 源码树、让 upstream 钉住的公共依赖保持不被 vendor，代价是发版多了一步访问公共 registry，以及当钉住的版本 upstream 尚未发布时发版失败而不是照常发布。当私服缺少某个版本时，安装仍会在镜像步骤之前失败，因此 upstream 钉入新包后的第一次发版仍需手工镜像一次。

## 测试

`packages/llm/llm-pi-ai` 通过 331 个测试，含 pre-abort 归类测试与 `pending`/`deferred` 映射；仓库 typecheck 覆盖漂移门禁。`scripts/release/mirror-packages.spec.ts` 覆盖 native 包发现、平台包优先的上传顺序、单版本基线、lockfile 钉住项及其"被依赖者优先"顺序，以及覆盖 scope 路由的 registry 读取参数。
