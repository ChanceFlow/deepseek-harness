/**
 * Uploading packed tarballs to a registry, and the three registry states one
 * upload decides between.
 *
 * Publication is decided per package against the registry, never from a list of
 * "what this release includes": a version the registry lacks is published, a
 * version whose published tarball has the same integrity is skipped, and a
 * version whose published tarball differs fails the run — that last case means
 * the content changed without a version bump
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Skipping on identical integrity is what makes re-running an upload over the
 * same artifact safe.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { attempt, attemptEchoed } from './process.ts'
import type { PackedIdentity } from './tarball.ts'

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one these
 * sequences actually hit: publishing several packages in a row can outrun the
 * registry's own processing. A rejected payload (`E403` over an existing
 * version, a malformed manifest) never clears on a retry and must surface.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4

/**
 * Shortest gap between two publishes, and the first retry backoff.
 *
 * The registry needs a moment to commit a packument before the next write; back
 * to back publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000

/** One tarball to upload: where it is, and what its own manifest declares. */
export interface PackedUpload extends PackedIdentity {
  /** Absolute path of the packed tarball. */
  readonly tarball: string
}

/** What the registry knows about one version. */
export type RegistryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/** How one upload run reports itself and assigns dist-tags. */
export interface UploadRun {
  /** Prefix on every line this run logs, so its step is greppable. */
  readonly label: string
  /**
   * The npm dist-tag to assign a version.
   * @param version - version from the packed manifest.
   * @returns The dist-tag, or undefined to leave npm its `latest` default.
   */
  readonly distTagForVersion: (version: string) => string | undefined
}

/** How far an upload run got. */
export interface UploadTotals {
  readonly published: number
  readonly skipped: number
}

/**
 * The npm dist-tag a version takes when the only distinction is release versus
 * prerelease: `next` for a prerelease, and npm's `latest` default otherwise.
 * @param version - version from the packed manifest.
 * @returns `next`, or undefined for a stable version.
 */
export function prereleaseDistTag(version: string): string | undefined {
  return version.includes('-') ? 'next' : undefined
}

/**
 * Whether a failed publish is worth another attempt.
 * @param output - combined npm output.
 * @returns True when the registry reported a write it did not commit.
 */
function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

/**
 * The subresource integrity string npm records for a tarball.
 * @param tarball - absolute tarball path.
 * @returns A `sha512-<base64>` string.
 */
export function integrityOf(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * The npm arguments that read a package from one named registry.
 *
 * A scoped `@scope:registry` in the ambient npm configuration outranks the
 * generic `--registry` flag, so naming another registry has to override the
 * scope as well: without it a source read answers from the configured registry
 * and the comparison against the source's own integrity silently checks a
 * registry against itself.
 * @param name - package name.
 * @param registry - registry URL to read the package from.
 * @returns The `--registry` flag plus the scope override for a scoped name.
 */
export function registrySourceArgs(name: string, registry: string): string[] {
  const separator = name.indexOf('/')
  const scope = name.startsWith('@') && separator > 1 ? name.slice(0, separator) : undefined
  return ['--registry', registry, ...scope === undefined ? [] : [`--${scope}:registry=${registry}`]]
}

/**
 * Ask a registry whether a version exists, and with what integrity.
 *
 * The registry is the one the ambient npm configuration resolves the package's
 * scope to unless `registry` names another, which is how an upload targets the
 * configured private registry while a mirror reads the public one.
 * @param name - package name.
 * @param version - package version.
 * @param registry - registry URL to query instead of the configured one.
 * @returns The registry state for that version.
 */
export function registryState(name: string, version: string, registry?: string): RegistryState {
  const args = ['view', `${name}@${version}`, 'dist.integrity', '--json']
  if (registry !== undefined) args.push(...registrySourceArgs(name, registry))
  const result = attempt('npm', args)
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' }
    throw new Error(`npm view ${name}@${version} failed:\n${output}`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`the registry reported no dist.integrity for ${name}@${version}`)
  }
  return { kind: 'present', integrity: parsed }
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param upload - the tarball and what it declares.
 * @param distTag - explicit npm dist-tag, or undefined for npm's `latest` default.
 * @param label - log-line prefix naming the step.
 */
async function publishTarball(upload: PackedUpload, distTag: string | undefined, label: string): Promise<void> {
  const { tarball, name, version } = upload
  const tagArgs = distTag === undefined ? [] : ['--tag', distTag]
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: every release member declares its own publishConfig, and
    // a command-line flag would override it. check-workspace-constraints
    // requires a public access level on every release member.
    const result = attemptEchoed('npm', ['publish', tarball, ...tagArgs])
    const output = `${result.stdout}${result.stderr}`
    if (result.status === 0) return

    const settled = registryState(name, version)
    if (settled.kind === 'present' && settled.integrity === integrityOf(tarball)) {
      console.log(`${label}: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `${label}: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
}

/**
 * Upload a whole ordered set of tarballs, deciding each one against the
 * registry.
 *
 * Every entry settles as either published or already present, so the returned
 * counts answer "how far along is this run" for whoever is watching a release
 * that takes minutes.
 * @param uploads - tarballs in upload order, each already packed.
 * @param run - how this run logs and assigns dist-tags.
 * @returns How many tarballs were published and how many were already present.
 */
export async function publishPackedSet(uploads: readonly PackedUpload[], run: UploadRun): Promise<UploadTotals> {
  const total = String(uploads.length)
  let published = 0
  let skipped = 0
  for (const [index, upload] of uploads.entries()) {
    const { tarball, name, version } = upload
    const progress = `[${String(index + 1)}/${total}]`
    const state = registryState(name, version)
    if (state.kind === 'present') {
      const local = integrityOf(tarball)
      if (state.integrity !== local) {
        throw new Error(
          `${name}@${version} is already published with different content`
          + `\n  registry: ${state.integrity}\n  packed:   ${local}`
          + '\nBump the version, or investigate why the build is not reproducible.',
        )
      }
      console.log(`${run.label}: ${progress} ${name}@${version} already published, skipping`)
      skipped += 1
      continue
    }
    // Space out the writes: the gap belongs between publishes, so a run that
    // only skips does not wait at all.
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    await publishTarball(upload, run.distTagForVersion(version), run.label)
    console.log(`${run.label}: ${progress} ${name}@${version} published`)
    published += 1
  }
  return { published, skipped }
}
