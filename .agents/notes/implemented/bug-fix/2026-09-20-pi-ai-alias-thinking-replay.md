# Agent Note: Replaying an aliased Anthropic answer as the requested model

Status: implemented

English | [中文](2026-09-20-pi-ai-alias-thinking-replay.zh.md)

## Problem

An Anthropic-Messages endpoint may answer under a name other than the requested model: an Anthropic dated alias or a fallback, or a gateway that fronts another vendor and reports its own model id. pi-ai assigns that reported name to the assistant message (`output.model = event.message.model`), so the durable replay state recorded it as `responseModel` and replayed it as the message's `model`. pi-ai's `transformMessages` decides same-model continuation with `assistantMsg.model === model.id`, so the aliased turn read as foreign history and its thinking block was downgraded to plain text before the request was built. The configured `compat.allowEmptySignature` never applied, because that switch is consulted after the same-model branch. Against a gateway that requires the assistant turn's thinking to be returned, every tool-calling turn after an aliased answer failed with `invalid_request_error` and the upstream error was surfaced as `400`.

The failure is intermittent by construction: only the answers whose reported name differs from the requested id are replayed as foreign. A deployment whose endpoint reports the requested id on one path and an alias on another fails on one path and succeeds on the other, with no configuration difference to explain it.

## Decision

Replay uses the requested model identity. `replayedAssistant` sets `model` from `response.model` — the requested id, already required to match the durable assistant source — and leaves the reported name in `responseModel`, where it stays informational. Same-model continuation then holds for an endpoint that answers under an alias, and the thinking block, including an empty signature, reaches the request.

The capture side is unchanged: `toPiReplayState` still records the reported name in `responseModel` when an Anthropic answer names a different model, so the durable log keeps the fact.

## Alternatives considered

**Require the endpoint to report the requested id.** Not expressible: the reported name belongs to the endpoint, and a gateway fronting another vendor reports its own model by design.

**Set `compat.allowEmptySignature` alone.** Insufficient. That switch selects how an unsigned thinking block travels once the block is kept; the block was already discarded by the same-model branch, so the switch had nothing to act on.

**Keep the alias in `model` and treat any same-provider, same-protocol turn as same-model.** This would discard the foreign-history distinction for a genuinely different model on the same route, which is exactly the case where a signature must not be replayed.

**Patch the same-model check in pi-ai.** The dependency is consumed unmodified, and its comparison is not wrong: an alias is indistinguishable from a fallback at that layer. The requested id is the fact this adapter owns.

## Consequences

A turn answered under another name replays as the requested model, so its thinking block and signature are preserved. A genuinely different model on the same route is still foreign history and still loses its thinking block. The recorded `responseModel` keeps the reported name for diagnostics; nothing reads it as identity.

Coverage lives in the Anthropic replay cases of `packages/llm/llm-pi-ai/tests/convert.spec.ts`, which assert the replayed identity, the retained `responseModel`, thinking retention when transforming for the requested model, and the foreign-model downgrade that must survive this change.

This partially supersedes the replay-provenance paragraph of [pi-ai upgrade compatibility](2026-09-05-pi-ai-upgrade-compatibility.md), which restored the reported native model on reconstruction; that note keeps its compatibility-field decisions and now links here for this one.
