/**
 * Mirror the native release sequence into the fork registry.
 *
 * The fork's `.npmrc` routes `@deepseek-ai` to the private registry, and four
 * dsh packages depend on `@deepseek-ai/node-addon-system`, so the version this
 * checkout pins has to exist there before any consumer installs a fork release.
 * The fork cannot build those packages itself: `native/system` needs one
 * runner per platform, macOS and a musl toolchain among them, which is what
 * upstream's own `Node Addon System Release` workflow exists for. This step
 * therefore mirrors the pinned version instead — fetching each public tarball
 * unchanged and requiring the private registry to hold the same bytes, which
 * is what lets a future release stop depending on a manual registry copy
 * ([rationale](../../.agents/notes/implemented/process/2026-08-17-fork-registry-and-pi-ai-chance-builds.md)).
 *
 * Usage: `mirror-native.ts [--source <registry>] [--out <directory>]`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { capture, isEntry } from './process.ts'
import { integrityOf, prereleaseDistTag, publishPackedSet, registryState, type PackedUpload } from './registry.ts'
import { packedIdentity } from './tarball.ts'

/** The repository-relative root of the native sequence's publishable packages. */
const NATIVE_PACKAGES_ROOT = 'native/system/packages'

/** Prefix on every line this step logs. */
const LABEL = 'release mirror-native'

/** One package of the native sequence, as the checkout pins it. */
export interface NativeMember {
  /** Repository-relative package directory. */
  readonly directory: string
  readonly name: string
  readonly version: string
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
    if (!name.startsWith('@deepseek-ai/')) throw new Error(`${manifestPath} must name an @deepseek-ai package`)
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
 * Fetch one published version's tarball and prove it is the payload the source
 * registry records.
 * @param member - the native package to fetch.
 * @param source - registry URL to fetch from.
 * @param directory - directory receiving the tarball.
 * @param integrity - the integrity `source` records for that version.
 * @returns The packed tarball, identified by its own manifest.
 */
function fetchTarball(member: NativeMember, source: string, directory: string, integrity: string): PackedUpload {
  const reported = capture('npm', [
    'pack',
    `${member.name}@${member.version}`,
    '--registry',
    source,
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

/** Mirror the version the checkout pins from `--source` into the configured registry. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const source = values.source ?? 'https://registry.npmjs.org'
  const directory = resolve(process.cwd(), values.out ?? 'dist/native-mirror')

  const members = nativeMembers(process.cwd())
  const version = members[0]?.version ?? ''
  const uploads: PackedUpload[] = []
  let mirrored = 0
  for (const member of members) {
    // The private registry resolves through the ambient npm configuration; the
    // public source is named explicitly, so a mirror image of the same scope
    // cannot answer for it.
    const published = registryState(member.name, member.version)
    const upstream = registryState(member.name, member.version, source)
    if (upstream.kind === 'absent') {
      throw new Error(
        `${member.name}@${member.version} is not on ${source}.`
        + '\nThe native workspace pins a version upstream has not published: build it through'
        + " the repository's Node Addon System Release workflow, or name the registry that"
        + ' carries it with --source.',
      )
    }
    if (published.kind === 'present') {
      if (published.integrity !== upstream.integrity) {
        throw new Error(
          `${member.name}@${member.version} is mirrored with different content`
          + `\n  published: ${published.integrity}\n  ${source}: ${upstream.integrity}`
          + '\nThe registry holds a payload the source does not; resolve it before releasing against it.',
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
    uploads.push(fetchTarball(member, source, directory, upstream.integrity))
  }

  if (uploads.length === 0) {
    console.log(`${LABEL}: native ${version}, ${String(members.length)} package(s), all already mirrored`)
    return
  }

  const { published, skipped } = await publishPackedSet(uploads, {
    label: LABEL,
    distTagForVersion: prereleaseDistTag,
  })
  console.log(
    `${LABEL}: native ${version}, ${String(members.length)} package(s), ${String(uploads.length)} fetched,`
    + ` ${String(published)} published, ${String(mirrored + skipped)} already present`,
  )
}

if (isEntry(import.meta.url)) await main()
