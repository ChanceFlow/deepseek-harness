# Agent Note: Fork registry releases and the pi-ai chance builds

Status: implemented

English | [中文](2026-08-17-fork-registry-and-pi-ai-chance-builds.zh.md)

## Problem

This checkout is a private fork deployed on a LAN whose npm registry is a Gitea package registry (`http://<gitea-host>:3000/api/packages/ChanceFlow/npm/`). The root `.npmrc` — deliberately gitignored — routes the `@deepseek-ai` and `@earendil-works` scopes to that registry, so installs never depend on public npm reachability. The fork publishes its own releases there with a `-chance.N` suffix on upstream's version (`0.1.0-rc.6-chance.1`), while upstream's public releases (`0.1.0-rc.7`) sit on the same registry under the `next` dist-tag.

Two facts about this layout are not visible from the repository alone, and the release state of 2026-08-17 was left uncommitted, so a later session had to rediscover them by forensic diffing. First, the registry also carries verbatim mirrors of public pi-ai releases (`0.82.1`, `0.84.1`, `0.84.2`, `0.85.1`, `0.86.1`) alongside the fork's patched `-chance` rebuilds. Second, the fork's `dsh-llm-pi-ai` once depended on a pi-ai capability no upstream release had: the Anthropic adapter honoring per-model `model.fetch`, which the per-provider `proxy` route field needed. Both are retired, and the dependency is a public version range.

## Decision

### pi-ai is mirrored, not built

The registry carries verbatim mirrors of the public pi-ai releases this checkout consumes (`0.82.1`, `0.84.1`, `0.84.2`, `0.85.1`, `0.86.1`), each verified against the integrity its public registry records, so a LAN machine installs pi-ai with no public npm access. `dsh-llm-pi-ai` depends on the public line with a caret range (`^0.85.1`), and nothing in the fork patches pi-ai.

The Anthropic streaming fix that motivated the 0.82.1 → 0.84.1 upgrade is still why the dependency is not older: 0.82.1 hardcodes `thinking: ""` and `thinkingSignature: ""` on `content_block_start`, so a gateway that emits complete thinking blocks at block start loses the reasoning content and the signature outright, while 0.84.1 onward reads the event's own fields.

The one-line `model.fetch` passthrough in the Anthropic adapter existed only for the per-route `proxy` field, and 0.84.1's `options.fetch` parameter had already replaced the per-model fetch it needed. The proxy field, its `undici` dependency, and the `0.85.1-chance.0` build are retired together, as is the pnpm `patchedDependencies` entry that preceded the build.

An exactly pinned `-chance` rebuild of pi-ai stays retired: semver orders a release above its prerelease, so `^0.85.1-chance.0` also matched the unpatched `0.85.1` mirror on the same registry and a fresh install silently resolved to the build without the passthrough. The fork's own `-chance` releases keep their exact pins; the pi-ai dependency is a public version range.

The registry's `latest` dist-tag for `@earendil-works/pi-ai` had been left on `0.85.1-chance.0`, so any `latest` resolution — `npm i @earendil-works/pi-ai`, or a dependency range that admits prereleases — installed the fork's private build. It now names the newest mirrored public release (`0.86.1`); Gitea's npm registry rejects `npm deprecate`, so the retired build stays listed but unreachable from both `latest` and the public version range. The behavior the dependency exists for is recorded in [holding a thinking block on the tool-call turns a provider left unsigned](../bug-fix/2026-09-21-pi-ai-held-thinking-on-tool-calls.md).

### Fork release state is committed at publish time

The whole-family version bump to `-chance.N` is committed when the release is published (staging tarballs land in `dist/npm-chance-N/`, now gitignored, and the registry serves the same version as `latest`). The repo's version fields otherwise track upstream's [three independent publication sequences](2026-08-10-npm-release-sequences.md); the next fork release after upstream's `0.1.0-rc.7` is `0.1.0-rc.7-chance.0`. The Gitea `sync-upstream` workflow merges `upstream/master` into the fork's `master` every six hours and fails loudly on conflict, so a conflicted sync is resolved once by hand — the 2026-08-17 merge of upstream's rc.6/rc.7 window was such a resolution.

### The pinned public @deepseek-ai packages are mirrored, not built

`native/system/packages/*` is upstream's third publication sequence, and four dsh packages depend on its entry package, `@deepseek-ai/node-addon-system`. Because the fork's `.npmrc` routes `@deepseek-ai` to the private registry, a fork release needs that version there — but the fork cannot build it: `native/system` needs one runner per platform, macOS and a musl toolchain among them, which is what upstream's own `Node Addon System Release` workflow exists for.

The vendored Cordis packages under `vendor/*` are the second source: they keep their upstream name and version, the fork's own release publishes none of them, and every dsh package declares them as peers, so the versions this checkout pins have to be in the private registry for a consumer to install a fork release at all. Upstream also pins public `@deepseek-ai` packages the fork never vendors — `@deepseek-ai/libreoffice-kit` and its platform packages arrived with 0.1.7-rc.2 — and those have the same requirement: `pnpm install --frozen-lockfile` resolves them through the routed scope, so a private registry that lacks one fails the install before any mirror step runs.

`scripts/release/mirror-packages.ts` mirrors every pinned version from all three sources instead of building or vendoring it, and the release workflow runs it before packing. The vendored packages are ordered by which of them another depends on; the native packages are read the way upstream's pack step does — `prebuilds.json` marks a platform package, and platform packages upload before the entries that optionally depend on them; the public dependencies come from `pnpm-lock.yaml`, whose `packages` section records the integrity `--frozen-lockfile` verifies, and whose `snapshots` section supplies the same depended-on-first order. Each member is then decided against both registries: the fetched tarball must hash to the integrity its pin source records, and the private registry must either lack the version (the fetched bytes are then published) or hold the same integrity (the version is skipped). A pinned version upstream has not published fails the step, naming the version; a private copy that differs from the pinned payload fails it too. Naming a source registry also has to override the scope registry, because `@deepseek-ai:registry` outranks `--registry`: without that, a source read answers from the private registry and the comparison checks a registry against itself.

### The 0.84 adaptation surface in dsh-llm-pi-ai

The pi-ai 0.84-only compat fields (`chatTemplateArgs`, `supportsFinishReason`, `supportsThinkingTokenBudget`, `supportsAdditionalTools`) are withheld in upstream's disposition gates until upstream's own pi-ai bump classifies them, and `baseten` stays in the thinking-format gate: upstream's rc.8 bidirectional profile-field check requires an offered field to match upstream's union exactly, so withdrawing one union member would mean editing upstream's safety invariant, while naming baseten with unconfigured `chatTemplateArgs` is the smaller divergence. The new `StopReason` members map explicitly: `pending` is a transport truncation — one more wording in the [flattened-message truncation classification](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md) — and `deferred` an unsupported completion mode. A terminal `error` while the caller's signal is already aborted is re-classified `aborted`: pi-ai 0.84 added `throwIfAborted()` to auth resolution, and the lazy setup wrapper turns that abort into a generic setup error event, while the same abort mid-stream keeps pi-ai's own `aborted` classification. The 0.84 catalog gives `deepseek-v4-flash` the `low` effort and `maxTokensField: max_tokens`.

## Alternatives considered

**Keep pnpm `patchedDependencies` for pi-ai.** The patch would live in git and survive registry outages, but it coexisted with the registry's pre-patched builds for two weeks and drifted — the registry's own `0.82.1` was a patched republish while the lockfile's integrity pinned the public vanilla tarball, so which mechanism applied depended on install order. One mechanism, the registry build, removes that class of accident.

**Publish only `-chance` builds to the registry and keep a caret range.** Dropping the vanilla `0.85.1` mirror would make `^0.85.1-chance.0` resolve to a patched build, but the mirror is what lets a LAN machine install pi-ai without public npm access, and a registry contents invariant is harder to see than an exact pin in `package.json`. The pin is the smaller, in-repo fact.

**Fix the setup-abort misclassification inside the `-chance` build (patch the lazy wrapper).** The wrapper's catch has no signal, so the patch would thread one through the setup closure; upstream may also reclassify setup aborts themselves. The adapter owns the caller signal and already matches pi-ai's own mid-stream tie-break (signal aborted wins over a racing provider error), so the remap lives in `adapter.ts` and the `-chance` delta stays one line.

## Consequences

The LAN registry serves installs with no install-time patching, and pi-ai reaches every machine as an unmodified public release, so the fork no longer rebuilds pi-ai on every upgrade: the pi-ai dependency is a caret range over mirrored public versions, while the fork's own releases keep their exact `-chance` pins. Upstream's eventual adoption of these surfaces will collide with the `baseten`/`StopReason`/abort adaptations and resolve them as no-ops. The type-level drift gates (`THINKING_FORMAT_GATE`, the `mapStopReason` switch) trip on the next pi-ai surface change on purpose.

Mirroring keeps `native/system` an upstream source tree the fork never builds and keeps upstream's pinned public dependencies unvendored, at the cost of a release step that reaches the public registry and of a release that fails rather than publishes when a pinned version upstream has not released. An install that needs a version the private registry lacks still fails before the mirror step runs, so the first release after upstream pins a new package mirrors it by hand — the 0.1.7-rc.2 release published a dsh family whose vendored Cordis peer (`~4.0.4`) the private registry lacked, and only a real `npm install -g` exposed it: neither `release:verify-packed-install` nor the release job's own install resolves a published release's peers.

## Testing

`packages/llm/llm-pi-ai` passes 331 tests including the pre-abort classification tests and the `pending`/`deferred` mappings; the repository typecheck covers the drift gates. `scripts/release/mirror-packages.spec.ts` covers native package discovery, the platform-first upload order, the one-version baseline, the lockfile pins and their depended-on-first order, and the registry read arguments that override a scope route.
