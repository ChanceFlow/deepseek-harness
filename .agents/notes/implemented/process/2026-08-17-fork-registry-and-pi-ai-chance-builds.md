# Agent Note: Fork registry releases and the pi-ai chance builds

Status: implemented

English | [中文](2026-08-17-fork-registry-and-pi-ai-chance-builds.zh.md)

## Problem

This checkout is a private fork deployed on a LAN whose npm registry is a Gitea package registry (`http://<gitea-host>:3000/api/packages/chanceflow/npm/`). The root `.npmrc` — deliberately gitignored — routes the `@deepseek-ai` and `@earendil-works` scopes to that registry, so installs never depend on public npm reachability. The fork publishes its own releases there with a `-chance.N` suffix on upstream's version (`0.1.0-rc.6-chance.1`), while upstream's public releases (`0.1.0-rc.7`) sit on the same registry under the `next` dist-tag.

Two facts about this layout are not visible from the repository alone, and the release state of 2026-08-17 was left uncommitted, so a later session had to rediscover them by forensic diffing. First, the registry also carries verbatim mirrors of public pi-ai releases (`0.82.1`, `0.84.1`, `0.84.2`) alongside the fork's patched `-chance` rebuilds. Second, the fork's `dsh-llm-pi-ai` depends on a pi-ai capability no upstream release has: the Anthropic adapter honoring per-model `model.fetch`, which the per-provider `proxy` route field needs (undici `ProxyAgent`-bound fetch on every model of a route; the `p1` route over `claude.p1.cn` requires it).

## Decision

### pi-ai 0.84.2-chance.0, pinned exactly

The pi-ai upgrade from 0.82.1 exists for the Anthropic streaming fix: 0.82.1 hardcodes `thinking: ""` and `thinkingSignature: ""` on `content_block_start`, so gateways that emit complete thinking blocks at block start lose the reasoning content and the signature outright. 0.84.1 onward reads the event's own fields. The upgrade also replaces 0.82.1's ad-hoc per-model fetch with an `options.fetch` parameter, dropping the `model.fetch` passthrough the proxy feature uses.

The registry build `0.84.2-chance.0` is vanilla 0.84.2 plus the one-line `model.fetch` passthrough in the Anthropic adapter. The pnpm `patchedDependencies` entry for pi-ai is retired — the patch travels inside the registry build instead.

The dependency is pinned `0.84.2-chance.0` without a caret, and the pin is load-bearing: `^0.84.2-chance.0` also matches the unpatched vanilla `0.84.2` mirror on the same registry, and semver orders the release above the prerelease, so a fresh install resolves to the build without the passthrough and the proxy stops working with no error anywhere. Every `-chance` build is pinned exactly.

### Fork release state is committed at publish time

The whole-family version bump to `-chance.N` is committed when the release is published (staging tarballs land in `dist/npm-chance-N/`, now gitignored, and the registry serves the same version as `latest`). The repo's version fields otherwise track upstream's [three independent publication sequences](2026-08-10-npm-release-sequences.md); the next fork release after upstream's `0.1.0-rc.7` is `0.1.0-rc.7-chance.0`. The Gitea `sync-upstream` workflow merges `upstream/master` into the fork's `master` every six hours and fails loudly on conflict, so a conflicted sync is resolved once by hand — the 2026-08-17 merge of upstream's rc.6/rc.7 window was such a resolution.

### The 0.84 adaptation surface in dsh-llm-pi-ai

The pi-ai 0.84-only compat fields (`chatTemplateArgs`, `supportsFinishReason`, `supportsThinkingTokenBudget`, `supportsAdditionalTools`) are withheld in upstream's disposition gates until upstream's own pi-ai bump classifies them, and `baseten` stays in the thinking-format gate: upstream's rc.8 bidirectional profile-field check requires an offered field to match upstream's union exactly, so withdrawing one union member would mean editing upstream's safety invariant, while naming baseten with unconfigured `chatTemplateArgs` is the smaller divergence. The new `StopReason` members map explicitly: `pending` is a transport truncation — one more wording in the [flattened-message truncation classification](../bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md) — and `deferred` an unsupported completion mode. A terminal `error` while the caller's signal is already aborted is re-classified `aborted`: pi-ai 0.84 added `throwIfAborted()` to auth resolution, and the lazy setup wrapper turns that abort into a generic setup error event, while the same abort mid-stream keeps pi-ai's own `aborted` classification. The 0.84 catalog gives `deepseek-v4-flash` the `low` effort and `maxTokensField: max_tokens`.

## Alternatives considered

**Keep pnpm `patchedDependencies` for pi-ai.** The patch would live in git and survive registry outages, but it coexisted with the registry's pre-patched builds for two weeks and drifted — the registry's own `0.82.1` was a patched republish while the lockfile's integrity pinned the public vanilla tarball, so which mechanism applied depended on install order. One mechanism, the registry build, removes that class of accident.

**Publish only `-chance` builds to the registry and keep a caret range.** Dropping the vanilla `0.84.2` mirror would make `^0.84.2-chance.0` resolve to a patched build, but the mirror is what lets a LAN machine install pi-ai without public npm access, and a registry contents invariant is harder to see than an exact pin in `package.json`. The pin is the smaller, in-repo fact.

**Fix the setup-abort misclassification inside the `-chance` build (patch the lazy wrapper).** The wrapper's catch has no signal, so the patch would thread one through the setup closure; upstream may also reclassify setup aborts themselves. The adapter owns the caller signal and already matches pi-ai's own mid-stream tie-break (signal aborted wins over a racing provider error), so the remap lives in `adapter.ts` and the `-chance` delta stays one line.

## Consequences

The fork carries a private pi-ai build that must be rebuilt on every pi-ai upgrade, and the exact pin makes each upgrade a deliberate commit rather than a lockfile drift; upstream's eventual 0.84 adoption will collide with the `baseten`/`StopReason`/abort adaptations and resolve them as no-ops. In exchange, the LAN registry serves installs with no install-time patching, the Anthropic thinking fix and the proxy passthrough reach every machine through one pinned version, and the type-level drift gates (`THINKING_FORMAT_GATE`, the `mapStopReason` switch) trip on the next pi-ai surface change on purpose.

## Testing

`packages/llm/llm-pi-ai` passes 218 tests including the pre-abort classification tests and the `pending`/`deferred` mappings; the repository typecheck covers the drift gates.
