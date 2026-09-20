# Agent Note: Holding a thinking block on the tool-call turns a provider left unsigned

Status: implemented

English | [中文](2026-09-21-pi-ai-held-thinking-on-tool-calls.zh.md)

## Problem

A gateway serving Anthropic-Messages in thinking mode enforces one rule: every assistant message containing a tool call must carry a thinking block. A request that omits one for any tool-calling turn is rejected as a whole with `invalid_request_error` — "The `content[].thinking` in the thinking mode must be passed back to the API" — and the step fails. Measured against the deployed gateway, an assistant turn with `tool_use` and no `thinking` fails, a thinking block with empty text and a missing or empty signature passes, and a text-only turn needs no block at all.

Two shapes of durable history reach the wire without that block. The provider may return no reasoning at all: replaying the deployed subagent request shape streamed `text` and two `tool_use` blocks with no thinking content block, on ten of ten attempts. Or the turn came from another provider that carries thinking in a provider-native field — a session switched between `google-vertex` and `p1` keeps Gemini tool-call turns whose thinking lives in `thoughtSignature` — and pi-ai drops that field when it converts for the Anthropic request.

Neither shape is repairable with pi-ai's own switches. `transform-messages` drops an empty thinking block on a foreign message, and `anthropic-messages` drops an empty-text thinking block that has no signature before `allowEmptySignature` is consulted; that switch only decides whether *non-empty* thinking text travels as a thinking block or as plain text. A tool-call turn with no thinking block is therefore unreachable from a durable turn that recorded no reasoning.

The endpoint also treats an absent `thinking` request field as enabled: deleting the field still produced the same rejection, and only an explicit `{"type":"disabled"}` disables the mode, at the cost of every later step's reasoning.

## Decision

`compat.allowEmptySignature` is the switch. On a route that declares it, `toPiAssistant` holds the passback invariant: a replayed assistant turn containing a tool call carries a thinking block. When the durable turn recorded no reasoning, DSH prepends an empty one with the placeholder signature `dsh-synthetic-thinking`; when it recorded a thinking block with empty text and no signature, DSH supplies the same placeholder so pi-ai keeps it. The block's text stays empty, so nothing model-visible is added — the placeholder exists only because pi-ai keeps an empty-text block solely when a signature is present.

The invariant applies in the same-model replay path only. Provider-neutral history — an unusable replay state, or a turn from another provider — leaves it unapplied, because pi-ai flattens a foreign empty thinking block regardless and a synthesized one there could not reach the wire.

`adapter.ts` derives the switch from `profile.compat.allowEmptySignature`, the route-level compat that `resolveModelCompat` already merges into every model on the route, so the behavior needs no new configuration field.

## Alternatives considered

**Delete the `thinking` request field, or stop configuring a reasoning effort.** Measured insufficient: the endpoint defaults to thinking mode, so the same history is still rejected. Only `{"type":"disabled"}` disables the mode, and it costs every subsequent step its reasoning.

**Synthesize thinking text instead of an empty block.** The endpoint accepts it, but it injects fabricated reasoning into the model's own history.

**Patch pi-ai to keep empty thinking blocks under `allowEmptySignature`.** One change would cover the same-model and foreign cases, but it reintroduces a private pi-ai build. The fork's only remaining reason for one was the per-route proxy passthrough, which is retired, and the published releases still drop the block through 0.86.1.

**Compact the session, or keep it on one provider.** Compaction only helps while the offending turns fall inside the summarized range, and it cannot remove the model's own most recent tool-call turn, whose tool result depends on it. The single-provider failures need no cross-provider history at all: the live failing main session had two blockless tool-call turns and `p1` produced both.

**Upgrade pi-ai.** Checked against 0.86.1: both guards are unchanged, so the upgrade cannot fix this.

## Consequences

On a route declaring `allowEmptySignature`, a tool-call turn the provider left without reasoning replays with an empty thinking block, the endpoint accepts the request, and the model sees no fabricated reasoning. A route that does not declare the switch replays exactly as before.

A foreign tool-call turn still reaches the wire without a thinking block, so a request whose history mixes another provider into a thinking route can still be rejected. Such a session keeps working on the provider that produced its history, or with thinking disabled.

Coverage lives in the held-thinking block of `packages/llm/llm-pi-ai/tests/convert.spec.ts`: synthesis for a tool-call turn, pi-ai's own `transformMessages` keeping the synthesized block for the requested model, the switch off, signature repair of an empty recording, recorded reasoning untouched, a text-only turn untouched, and provider-neutral history untouched. The package suite is 331 tests. Live verification reconstructed the failing request from its session log and posted it to the gateway unchanged and through this path: 400 before, 200 after, on the enforcing backend.

This note is the second half of the replay fix whose alias half is [replaying an aliased Anthropic answer as the requested model](2026-09-20-pi-ai-alias-thinking-replay.md). It also retires the last reason for a private pi-ai build recorded in [fork registry releases and the pi-ai chance builds](../process/2026-08-17-fork-registry-and-pi-ai-chance-builds.md).
