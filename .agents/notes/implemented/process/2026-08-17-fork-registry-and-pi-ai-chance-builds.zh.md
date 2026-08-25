# Agent Note: Fork 私服发版与 pi-ai chance 构建

Status: implemented

[English](2026-08-17-fork-registry-and-pi-ai-chance-builds.md) | 中文

## 问题

本 checkout 是部署在内网的私有 fork，其 npm registry 是一个 Gitea 包仓库（`http://<gitea-host>:3000/api/packages/ChanceFlow/npm/`）。根目录 `.npmrc`——按设计被 gitignore——把 `@deepseek-ai` 与 `@earendil-works` 两个 scope 指向该私服，安装因此不依赖公共 npm 的可达性。fork 在 upstream 版本号后追加 `-chance.N` 后缀发布自己的版本（`0.1.0-rc.6-chance.1`），而 upstream 的公开发版（`0.1.0-rc.7`）以 `next` dist-tag 并存于同一私服。

这个布局有两个事实单看仓库看不出来，而 2026-08-17 的发版状态又没提交，导致后来的会话只能靠取证式 diff 重新发现它们。其一，私服上除 fork 打过补丁的 `-chance` 重建版外，还镜像了公共 pi-ai 的原版发布（`0.82.1`、`0.84.1`、`0.84.2`）。其二，fork 的 `dsh-llm-pi-ai` 依赖一个任何 upstream 版本都没有的 pi-ai 能力：Anthropic 适配器认 per-model `model.fetch`，per-provider `proxy` 路由字段需要它（给路由上每个模型挂 undici `ProxyAgent` 绑定的 fetch；走 `claude.p1.cn` 的 `p1` 路由离不开它）。

## 决策

### pi-ai 0.84.2-chance.0，精确钉版

从 0.82.1 升级 pi-ai 是为了 Anthropic 流式修复：0.82.1 在 `content_block_start` 上硬编码 `thinking: ""` 与 `thinkingSignature: ""`，凡是把完整 thinking 块直接放在块起始事件里的网关，推理内容和签名都会被整体丢弃。0.84.1 起改读事件自带的字段。这次升级同时把 0.82.1 的临时 per-model fetch 换成了 `options.fetch` 参数，丢掉了 proxy 功能所依赖的 `model.fetch` 透传。

私服构建 `0.84.2-chance.0` 等于原版 0.84.2 加 Anthropic 适配器里那一行 `model.fetch` 透传。pi-ai 的 pnpm `patchedDependencies` 条目随之退役——补丁改由私服构建携带。

依赖钉在 `0.84.2-chance.0`，不带 caret，而且这个钉版是承重的：`^0.84.2-chance.0` 同样匹配同一私服上未打补丁的原版 `0.84.2` 镜像，而 semver 把 release 排在 prerelease 之前，全新安装会解析到没有透传的构建，proxy 无声失效且没有任何报错。每个 `-chance` 构建都必须精确钉版。

### fork 发版状态在发布时提交

全家桶 `-chance.N` 版本号 bump 在发布时一并提交（staging tarball 落在 `dist/npm-chance-N/`，现已 gitignore，私服同时以 `latest` 提供同一版本）。除此之外仓库版本号跟随 upstream 的[三条独立发布序列](2026-08-10-npm-release-sequences.md)；upstream `0.1.0-rc.7` 之后的下一个 fork 版本是 `0.1.0-rc.7-chance.0`。Gitea 的 `sync-upstream` workflow 每 6 小时把 `upstream/master` 合入 fork 的 `master`，冲突即显式失败，因此冲突同步由人工一次性解决——2026-08-17 对 upstream rc.6/rc.7 窗口的合并就是一次这样的解决。

### dsh-llm-pi-ai 的 0.84 适配面

pi-ai 0.84 独有的 compat 字段（`chatTemplateArgs`、`supportsFinishReason`、`supportsThinkingTokenBudget`、`supportsAdditionalTools`）在上游的 disposition gate 中保持 withhold，直到上游自己的 pi-ai 升级对它们分类；`baseten` 则留在 thinking-format gate 里：上游 rc.8 的双向 profile 字段检查要求 offered 字段与上游联合类型完全一致，退出一个联合成员等于改写上游的安全不变式，而带着未配置的 `chatTemplateArgs` 命名 baseten 是更小的分歧。新的 `StopReason` 成员都有显式映射：`pending` 是传输截断——是[扁平化消息截断分类](../bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md)里的又一种措辞——`deferred` 是不支持完成模式。调用方 signal 已 abort 时，终态 `error` 会被重新归类为 `aborted`：pi-ai 0.84 在鉴权解析里加了 `throwIfAborted()`，惰性 setup 包装器把这个 abort 变成了通用的 setup 错误事件，而同一 abort 发生在流中时 pi-ai 自己仍归类为 `aborted`。0.84 目录给 `deepseek-v4-flash` 增加了 `low` 档，并把 `maxTokensField` 定为 `max_tokens`。

## 考虑过的替代方案

**继续用 pnpm `patchedDependencies` 给 pi-ai 打补丁。** 补丁放在 git 里、不惧私服故障，但它与私服预打补丁的构建并存了两周并发生了漂移——私服上的 `0.82.1` 是打过补丁的重发布，而 lockfile 的 integrity 却钉着公共原版 tarball，哪套机制生效取决于安装顺序。只留私服构建这一套机制，消除了这类事故。

**只往私服发 `-chance` 构建并保留 caret 范围。** 撤掉原版 `0.84.2` 镜像后 `^0.84.2-chance.0` 会解析到打补丁的构建，但镜像正是内网机器不需要公共 npm 就能装 pi-ai 的依靠，而且「私服内容不变式」比 `package.json` 里的精确钉版更难被看见。钉版是更小、就在仓库里的事实。

**在 `-chance` 构建内部修 setup-abort 误分类（补惰性包装器）。** 包装器的 catch 拿不到 signal，补丁得把 signal 穿进 setup 闭包；upstream 也可能自己重新归类 setup abort。适配器持有调用方 signal，且本来就在跟随 pi-ai 自己的流中裁决（signal 已 abort 胜过竞态的 provider 错误），因此重映射放在 `adapter.ts`，`-chance` 的差异保持一行。

## 后果

fork 背上了一个每次升级 pi-ai 都要重建的私有构建，精确钉版让每次升级都成为一次郑重的提交而非 lockfile 漂移；upstream 将来采用 0.84 时会撞上 `baseten`/`StopReason`/abort 这些适配，届时它们作为无操作解决。换来的是：内网私服的安装不需要任何安装期补丁，Anthropic thinking 修复和 proxy 透传通过一个钉死的版本到达每台机器，而类型级漂移门禁（`THINKING_FORMAT_GATE`、`mapStopReason` 的 switch）会在下一次 pi-ai 面变化时按设计跳闸。

## 测试

`packages/llm/llm-pi-ai` 通过 218 个测试，含 pre-abort 归类测试与 `pending`/`deferred` 映射；仓库 typecheck 覆盖漂移门禁。
