/**
 * Mirror the pinned public `@deepseek-ai` packages into the fork registry.
 *
 * The fork's `.npmrc` routes the whole `@deepseek-ai` scope to the private
 * registry, so every `@deepseek-ai` package a fork release's consumers resolve
 * has to exist there before anything is published. Two pin sources name that
 * set: the `native/system` sequence, which the fork cannot build (one runner
 * per platform, macOS and a musl toolchain among them), and the registry
 * resolutions `pnpm-lock.yaml` records for the public `@deepseek-ai`
 * dependencies upstream added, which the fork never vendors.
 *
 * This step mirrors each pinned version instead of building or vendoring it:
 * it fetches the public tarball unchanged and requires the private registry to
 * hold the same bytes, which is what lets a release stop depending on a manual
 * registry copy
 * ([rationale](../../.agents/notes/implemented/process/2026-08-17-fork-registry-and-pi-ai-chance-builds.md)).
 *
 * Usage: `mirror-packages.ts [--source <registry>] [--out <directory>]`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load as loadYaml } from 'js-yaml'
import { capture, isEntry } from './process.ts'
import {
  integrityOf,
  prereleaseDistTag,
  publishPackedSet,
  registrySourceArgs,
  registryState,
  type PackedUpload,
} from './registry.ts'
import { packedIdentity } from './tarball.ts'

/** The repository-relative root of the native sequence's publishable packages. */
const NATIVE_PACKAGES_ROOT = 'native/system/packages'

/** The package scope this step mirrors; the fork owns no other public scope. */
const MIRRORED_SCOPE = '@deepseek-ai/'

/** Prefix on every line this step logs. */
const LABEL = 'release mirror-packages'

/** One `@deepseek-ai` package the fork registry must hold, and the bytes it must hold. */
export interface MirroredMember {
  readonly name: string
  readonly version: string
  /**
   * Integrity the pin source records, when it records one. The lockfile is the
   * authority for a dependency it resolves; a native package is pinned only by
   * version, so its integrity comes from the public registry.
   */
  readonly integrity?: string
}

/** One package of the native sequence, as the checkout pins it. */
export interface NativeMember {
  /** Repository-relative package directory. */
  readonly directory: string
  readonly name: string
  readonly version: string
}

/** The lockfile sections this step reads. */
interface LockfileShape {
  packages?: Record<string, { resolution?: { integrity?: unknown } } | undefined>
  snapshots?: Record<string, {
    dependencies?: Record<string, unknown>
    optionalDependencies?: Record<string, unknown>
  } | undefined>
}

/**
 * Read the native sequence's publishable packages in upload order.
 *
 * Upload order is platform packages before the entries that optionally depend
 * on them, which npm needs so a mirrored entry version never points ahead of
 * its platform packages. `prebuilds.json` is what marks a platform package;
 * `native/system/scripts/repo.mjs` owns that convention and the pack step that
 * writes the same order.
 * @param root - repository root.
 * @returns The members, platform packages first, each directory sorted by name.
 */
export function nativeMembers(root: string): NativeMember[] {
  const packagesRoot = join(root, NATIVE_PACKAGES_ROOT)
  const platforms: NativeMember[] = []
  const entries: NativeMember[] = []
  const names = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  for (const directory of names) {
    const manifestPath = join(packagesRoot, directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`${manifestPath} is not a JSON object`)
    }
    const { private: isPrivate, name, version } = manifest as Record<string, unknown>
    if (isPrivate === true) continue
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`${manifestPath} must declare string name and version`)
    }
    if (!name.startsWith(MIRRORED_SCOPE)) throw new Error(`${manifestPath} must name an @deepseek-ai package`)
    const member: NativeMember = { directory: `${NATIVE_PACKAGES_ROOT}/${directory}`, name, version }
    if (existsSync(join(packagesRoot, directory, 'prebuilds.json'))) platforms.push(member)
    else entries.push(member)
  }

  const members = [...platforms, ...entries]
  if (members.length === 0) throw new Error(`${NATIVE_PACKAGES_ROOT} holds no publishable native package`)
  const versions = new Set(members.map(member => member.version))
  if (versions.size !== 1) {
    const detail = members.map(member => `${member.directory}: ${member.version}`).join('\n')
    throw new Error(`the native workspace publishes one version across its packages:\n${detail}`)
  }
  return members
}

/**
 * Split a lockfile package key into its name and version.
 * @param key - a `name@version` key, optionally carrying pnpm's peer suffix.
 * @returns The identity, or undefined when the key carries no version.
 */
function registryIdentity(key: string): { name: string; version: string } | undefined {
  const withoutPeers = key.split('(')[0] ?? key
  const separator = withoutPeers.lastIndexOf('@')
  if (separator <= 0) return undefined
  return { name: withoutPeers.slice(0, separator), version: withoutPeers.slice(separator + 1) }
}

/**
 * Read the public `@deepseek-ai` packages the lockfile resolves from a registry.
 *
 * The lockfile is the resolution authority: its `packages` section records the
 * integrity pnpm verifies at install time, so a mirrored copy that satisfies
 * that record is what `--frozen-lockfile` needs. A workspace or link
 * resolution records no integrity and is not mirrored. Members another member
 * depends on come first, matching the native upload order so a published entry
 * version never points at a platform package the registry lacks.
 * @param lockfile - the repository's `pnpm-lock.yaml` contents.
 * @returns The members, depended-on packages first.
 */
export function lockedMembers(lockfile: string): MirroredMember[] {
  const parsed = loadYaml(lockfile) as LockfileShape | undefined
  const members = new Map<string, MirroredMember>()
  for (const [key, entry] of Object.entries(parsed?.packages ?? {})) {
    const identity = registryIdentity(key)
    if (identity === undefined || !identity.name.startsWith(MIRRORED_SCOPE)) continue
    const integrity = entry?.resolution?.integrity
    if (typeof integrity !== 'string' || integrity === '') continue
    members.set(key, { ...identity, integrity })
  }
  const dependedOn = new Set<string>()
  const names = new Set([...members.values()].map(member => member.name))
  for (const [key, snapshot] of Object.entries(parsed?.snapshots ?? {})) {
    if (!members.has(key)) continue
    for (const section of [snapshot?.dependencies, snapshot?.optionalDependencies]) {
      for (const dependency of Object.keys(section ?? {})) {
        if (names.has(dependency)) dependedOn.add(dependency)
      }
    }
  }
  return [...members.values()].sort((left, right) => (
    Number(dependedOn.has(right.name)) - Number(dependedOn.has(left.name))
    || left.name.localeCompare(right.name)
  ))
}

/**
 * The union of both pin sources, each pinned version once.
 * @param root - repository root.
 * @returns Every member this step mirrors, lockfile members first.
 */
export function mirrorMembers(root: string): MirroredMember[] {
  const locked = lockedMembers(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const native: MirroredMember[] = nativeMembers(root).map(({ name, version }) => ({ name, version }))
  const members = new Map<string, MirroredMember>()
  for (const member of [...locked, ...native]) {
    const key = `${member.name}@${member.version}`
    const existing = members.get(key)
    if (existing !== undefined && existing.integrity !== member.integrity) {
      throw new Error(`${key} is pinned with two different integrities`)
    }
    members.set(key, existing ?? member)
  }
  return [...members.values()]
}

/**
 * Read the integrity the public registry records for one pinned version.
 * @param member - the package to read.
 * @param source - registry URL to read from.
 * @returns The integrity that version must hash to.
 */
function sourceIntegrity(member: MirroredMember, source: string): string {
  const upstream = registryState(member.name, member.version, source)
  if (upstream.kind === 'absent') {
    throw new Error(
      `${member.name}@${member.version} is not on ${source}.`
      + '\nThe checkout pins a version upstream has not published: publish it upstream, or name'
      + ' the registry that carries it with --source.',
    )
  }
  return upstream.integrity
}

/**
 * Fetch one published version's tarball and prove it is the payload the pin
 * source records.
 * @param member - the package to fetch.
 * @param source - registry URL to fetch from.
 * @param directory - directory receiving the tarball.
 * @param integrity - the integrity the pin source records for that version.
 * @returns The packed tarball, identified by its own manifest.
 */
function fetchTarball(member: MirroredMember, source: string, directory: string, integrity: string): PackedUpload {
  const reported = capture('npm', [
    'pack',
    `${member.name}@${member.version}`,
    ...registrySourceArgs(member.name, source),
    '--pack-destination',
    directory,
  ]).split('\n').filter(line => line.trim() !== '').at(-1)
  if (reported === undefined) throw new Error(`npm pack ${member.name}@${member.version} named no tarball`)
  const tarball = resolve(directory, reported)
  const identity = packedIdentity(tarball)
  if (identity.name !== member.name || identity.version !== member.version) {
    throw new Error(`npm pack wrote ${identity.name}@${identity.version}, expected ${member.name}@${member.version}`)
  }
  const fetched = integrityOf(tarball)
  if (fetched !== integrity) {
    throw new Error(
      `${member.name}@${member.version} does not match the integrity ${source} records`
      + `\n  registry: ${integrity}\n  fetched:  ${fetched}`,
    )
  }
  return { tarball, ...identity }
}

/** Mirror every pinned `@deepseek-ai` package from `--source` into the configured registry. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const source = values.source ?? 'https://registry.npmjs.org'
  const directory = resolve(process.cwd(), values.out ?? 'dist/package-mirror')

  const members = mirrorMembers(process.cwd())
  const uploads: PackedUpload[] = []
  let mirrored = 0
  for (const member of members) {
    // The private registry resolves through the ambient npm configuration; the
    // public source is named explicitly, so a mirror image of the same scope
    // cannot answer for it.
    const expected = member.integrity ?? sourceIntegrity(member, source)
    const published = registryState(member.name, member.version)
    if (published.kind === 'present') {
      if (published.integrity !== expected) {
        throw new Error(
          `${member.name}@${member.version} is mirrored with different content`
          + `\n  published: ${published.integrity}\n  pinned:    ${expected}`
          + '\nThe registry holds a payload the pin does not; resolve it before releasing against it.',
        )
      }
      console.log(`${LABEL}: ${member.name}@${member.version} already mirrored, skipping`)
      mirrored += 1
      continue
    }
    if (uploads.length === 0) {
      rmSync(directory, { recursive: true, force: true })
      mkdirSync(directory, { recursive: true })
    }
    uploads.push(fetchTarball(member, source, directory, expected))
  }

  if (uploads.length === 0) {
    console.log(`${LABEL}: ${String(members.length)} package(s) pinned, all already mirrored`)
    return
  }

  const { published, skipped } = await publishPackedSet(uploads, {
    label: LABEL,
    distTagForVersion: prereleaseDistTag,
  })
  console.log(
    `${LABEL}: ${String(members.length)} package(s) pinned, ${String(uploads.length)} fetched,`
    + ` ${String(published)} published, ${String(mirrored + skipped)} already present`,
  )
}

if (isEntry(import.meta.url)) await main()
