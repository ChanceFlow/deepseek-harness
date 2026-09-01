# Agent Note: Mirror the fork's master to a GitHub fork from Gitea Actions

Status: implemented

English | [中文](2026-09-01-gitea-github-fork-mirror.zh.md)

## Problem

The fork's master advances on the Gitea instance at <gitea-host>: development commits land directly on it, and the `sync-upstream` cron merges `GithubMirror/deepseek-harness` into it. GitHub consumers need the same content, and no GitHub fork of `deepseek-ai/deepseek-harness` existed for this account. The host's `gh` CLI is authenticated as `ChanceFlow` with `repo` scope, and the `dsh-host` Actions runner executes as that same user, but its registration still pointed at the retired `<gitea-legacy-host>` address from before the network migration, so it fetched no tasks and every `dsh-host` job was unschedulable.

## Decision

`push-to-github.yml` runs on every push to the fork's master — development pushes and cron merges alike — and force-pushes the Gitea master to `github.com/ChanceFlow/deepseek-harness`, creating the fork from `deepseek-ai/deepseek-harness` with `gh repo fork` on the first run if it is absent. Gitea is the single source of truth; the fork is a pure downstream mirror and nothing else may write its master branch.

The job runs on the `dsh-host` runner rather than a container: the authenticated `gh` CLI, its git credential helper, and the runner-configured HTTP(S) proxy already exist on the host, so the workflow needs no Gitea secret carrying a GitHub token. Each run refreshes a persistent bare clone under `~/.cache/gh-fork-sync` from the Gitea HTTP URL and pushes the single `master` ref, keeping per-run traffic incremental. The `push-to-github` concurrency group serializes runs. The pre-push `typecheck` hook still guards what reaches master.

Repairing the runner required editing only the `address` field of its `.runner` registration: the same Gitea database survived the migration to <gitea-host>, so the runner token remained valid and the runner declared successfully after a restart.

## Alternatives considered

**Gitea's built-in push-mirror.** A repository setting that forwards each push requires no YAML, but its credentials and destination live outside version control, invisible to review and to this file, and it cannot create the fork when it is absent.

**A container job installing `gh` and mounting `~/.config/gh`.** check.yml proves container volume mounts reach host paths, so this works, but it re-implements the host's existing gh login and proxy setup per image while offering no isolation benefit — the operation is a single git push.

**A GitHub PAT stored as a Gitea Actions secret.** Keeps the job container-schedulable, but duplicates a credential that then must be rotated in two places; the host gh login is already scoped and owned.

**Fast-forward-only push.** Refuses upstream merges that were non-fast-forward in Gitea master, wedging the mirror on exactly the pushes the `sync-upstream` cron produces.

## Consequences

GitHub now receives every fork master commit within one Actions queue delay, with no second place to publish. The mirror's correctness rests on two facts outside this file: the `dsh-host` runner staying registered at <gitea-host> with `gh` logged in as `ChanceFlow`, and master-only protection of nothing — anyone with GitHub write access who pushes to the fork's master will have it overwritten by the next Gitea push, which is the intended authority order. Force-push semantics mean a local correction pushed to Gitea instantly rewrites the fork; the fork never diverges. The bare cache under `~/.cache/gh-fork-sync` is disposable: deleting it costs one full-repository fetch on the next run.
