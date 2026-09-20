# Agent Note: 别名 Anthropic 应答按请求模型身份回放

Status: implemented

[English](2026-09-20-pi-ai-alias-thinking-replay.md) | 中文

## 问题

Anthropic Messages 端点可能用请求之外的名字作答：Anthropic 的日期别名或 fallback，或一个前置其他厂商、报告自身模型 id 的网关。pi-ai 会把这个上报名赋给 assistant 消息（`output.model = event.message.model`），于是持久化回放状态把它记成 `responseModel`，并在回放时当作消息的 `model`。pi-ai 的 `transformMessages` 用 `assistantMsg.model === model.id` 判定同模型续写，因此这条被别名的轮次被读成外来历史，其 thinking 块在构造请求前就被降级为纯文本。配置的 `compat.allowEmptySignature` 从未生效——该开关在同模型分支之后才会被查询。面对要求回传 assistant 轮次 thinking 的网关，每一次别名应答之后的工具调用轮次都以 `invalid_request_error` 失败，上游错误以 `400` 暴露。

该故障天生是间歇的：只有上报名与请求 id 不同的那些应答会被当作外来历史回放。若某个部署的端点在一条路径上报告请求 id、在另一条路径上报告别名，就会一条路径失败、另一条成功，而配置上没有任何差异可以解释它。

## 决策

回放使用请求的模型身份。`replayedAssistant` 用 `response.model`——即已被要求与持久化 assistant 来源一致的请求 id——设置 `model`，并把上报名留在 `responseModel`，仅作信息用途。于是对以别名作答的端点，同模型续写成立，thinking 块（含空签名）得以进入请求。

捕获侧不变：当 Anthropic 应答命名了另一个模型时，`toPiReplayState` 仍把上报名记入 `responseModel`，持久化日志保留该事实。

## 考虑过的替代方案

**要求端点报告请求 id。** 不可表达：上报名属于端点，而前置其他厂商的网关按其设计报告自身模型。

**仅设置 `compat.allowEmptySignature`。** 不充分。该开关决定无签名 thinking 块在保留之后如何传输；该块此前已被同模型分支丢弃，开关无从作用。

**把别名留在 `model`，并把任何同厂商同协议的轮次都当作同模型。** 这会丢掉同路由上真正不同模型的外来历史判定，而那正是签名不得回放的场合。

**在 pi-ai 中修补同模型判定。** 该依赖以未修改形式消费，且它的比较并不错：在该层，别名与 fallback 不可区分。请求 id 才是本适配器拥有的事实。

## 后果

以其他名字作答的轮次按请求模型回放，因此其 thinking 块与签名被保留。同路由上真正不同的模型仍是外来历史，仍会失去 thinking 块。记录的 `responseModel` 为诊断保留上报名；没有代码把它当作身份读取。

覆盖位于 `packages/llm/llm-pi-ai/tests/convert.spec.ts` 的 Anthropic 回放用例，断言回放身份、保留的 `responseModel`、按请求模型转换时 thinking 的保留，以及本次改动必须保住的异模型降级。

本注部分取代 [pi-ai 升级兼容性](2026-09-05-pi-ai-upgrade-compatibility.zh.md) 中关于回放来源的段落——该段在重建时恢复上报的原生模型；那条注保留其兼容字段决策，并就此一处链接到本注。
