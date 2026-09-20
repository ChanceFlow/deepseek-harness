# Agent Note: 为 provider 未给出签名的工具调用轮次保留 thinking 块

Status: implemented

[English](2026-09-21-pi-ai-held-thinking-on-tool-calls.md) | 中文

## Problem

以 Anthropic-Messages 协议提供 thinking 模式的网关强制一条规则：每一条包含工具调用的 assistant 消息都必须携带 thinking 块。任何一条工具调用轮次缺少该块，整个请求都会被以 `invalid_request_error` 拒绝——"The `content[].thinking` in the thinking mode must be passed back to the API"——该 step 失败。针对已部署网关实测：assistant 轮含 `tool_use` 而无 `thinking` 会失败；文本为空、签名缺失或为空的 thinking 块可以通过；纯文本轮次完全不需要该块。

有两种形态的持久历史会不带该块到达线上。其一是 provider 根本没返回 reasoning：重放已部署的子 agent 请求形态时，十次全部只流出 `text` 与两个 `tool_use`，流里没有任何 thinking 内容块。其二是该轮来自另一个 provider，其 thinking 存放在 provider 原生字段里——在 `google-vertex` 与 `p1` 之间切换过的会话会保留 Gemini 的工具调用轮次，其 thinking 位于 `thoughtSignature`——而 pi-ai 在为 Anthropic 请求做转换时会丢掉该字段。

这两种形态都无法用 pi-ai 自身的开关修好。`transform-messages` 会丢弃外来消息上的空 thinking 块；`anthropic-messages` 会在 `allowEmptySignature` 被查询之前就丢弃"文本为空且没有签名"的 thinking 块，而那个开关只决定**非空**的 thinking 文本是以 thinking 块还是以纯文本形式传输。因此，对于一条没有记录 reasoning 的持久轮次，线上根本无法出现带 thinking 块的工具调用轮次。

该端点还把 `thinking` 请求字段的缺失视为开启：删掉该字段仍然得到同样的拒绝，只有显式的 `{"type":"disabled"}` 才能关闭该模式，代价是其后每个 step 都失去推理。

## Decision

开关是 `compat.allowEmptySignature`。在声明了它的路由上，`toPiAssistant` 维持回传不变量：一条被重放、且包含工具调用的 assistant 轮次必须携带 thinking 块。当持久轮次没有记录 reasoning 时，DSH 前置一个文本为空、签名为占位值 `dsh-synthetic-thinking` 的块；当它记录的 thinking 块文本为空且没有签名时，DSH 补上同一个占位签名，使 pi-ai 保留它。该块文本始终为空，因此没有增加任何模型可见内容——占位签名之所以存在，只是因为 pi-ai 仅在签名存在时才保留空文本块。

该不变量只作用于同模型重放路径。Provider 中立历史——不可用的 replay state，或来自另一个 provider 的轮次——不应用它，因为 pi-ai 无论如何都会拍平外来消息上的空 thinking 块，在那里合成出来的块到不了线上。

`adapter.ts` 从 `profile.compat.allowEmptySignature` 推导该开关，这正是 `resolveModelCompat` 已经合并进该路由每个模型的路由级 compat，因此该行为不需要任何新的配置字段。

## Alternatives considered

**删掉 `thinking` 请求字段，或不再配置 reasoning effort。** 实测无效：该端点默认处于 thinking 模式，同样的历史仍然被拒绝。只有 `{"type":"disabled"}` 能关闭该模式，而它会让其后每一步都失去推理。

**合成 thinking 文本，而不是空块。** 端点会接受，但这等于把编造的推理注入模型自己的历史。

**改 pi-ai，让它在 `allowEmptySignature` 下保留空 thinking 块。** 一处改动即可覆盖同模型与外来两种情况，但它会重新引入私有 pi-ai 构建。这个 fork 保留私有构建的唯一剩余理由是按路由的代理直通，而它已退役；并且已发布的各个版本直到 0.86.1 仍然会丢弃该块。

**对会话做 compaction，或让会话只待在单一 provider 上。** compaction 只在出问题的轮次落入被摘要的区间时才有用，而且它无法移除模型自己最近的那个工具调用轮次——其工具结果依赖该轮次。只用一个 provider 的那些失败根本不需要跨 provider 历史：线上失败的主会话里有两个缺块的工具调用轮次，两个都由 `p1` 产生。

**升级 pi-ai。** 已对照 0.86.1 检查：两处守卫都没有变化，因此升级修不了这个问题。

## Consequences

在声明了 `allowEmptySignature` 的路由上，provider 未给出 reasoning 的工具调用轮次会带着一个空 thinking 块被重放，端点接受该请求，模型也看不到任何编造的推理。没有声明该开关的路由与之前完全一致。

外来的工具调用轮次仍然会不带 thinking 块到达线上，因此历史中混入了其他 provider 的请求仍可能被拒绝。这类会话可以继续在产生其历史的那个 provider 上运行，或者关闭 thinking。

覆盖位于 `packages/llm/llm-pi-ai/tests/convert.spec.ts` 的 held-thinking 测试块：工具调用轮次的合成、pi-ai 自身的 `transformMessages` 会为所请求模型保留合成块、开关关闭、对空记录的签名修复、已记录的 reasoning 不受影响、纯文本轮次不受影响、provider 中立历史不受影响。该包测试套件为 331 个用例。线上验证从会话日志重建了那条失败请求，并将其原样与经由本路径分别投给网关：在强制后端上，修复前 400，修复后 200。

本篇是这次重放修复的后半部分，其别名部分见 [replaying an aliased Anthropic answer as the requested model](2026-09-20-pi-ai-alias-thinking-replay.zh.md)。它也终结了 [fork registry releases and the pi-ai chance builds](../process/2026-08-17-fork-registry-and-pi-ai-chance-builds.zh.md) 中记录的"需要私有 pi-ai 构建"的最后一个理由。
