/**
 * Publish one packed release family from the tarballs the pack step produced.
 *
 * The family uploads in the order pack recorded, so an interrupted run leaves
 * exactly a prefix of it. What each tarball does against the registry — land,
 * skip as already present, or fail as content that changed without a version
 * bump — is [registry.ts](registry.ts)'s decision.
 */

import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { isEntry } from './process.ts'
import { publishPackedSet, type PackedUpload } from './registry.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

/** Publish the family named by `--family` from the directory named by `--from`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error('usage: publish.ts --family <dsh|vendor> --from <packed directory>')
  }

  const family = releaseFamily(values.family)
  const directory = resolve(process.cwd(), values.from)

  // Read the upload order first: it is the release's own plan, so a partial run
  // leaves a prefix of exactly this list.
  const order = readPublishOrder(directory)
  const uploads: PackedUpload[] = order.map((filename) => {
    const tarball = join(directory, filename)
    return { tarball, ...packedIdentity(tarball) }
  })

  const { published, skipped } = await publishPackedSet(uploads, {
    label: 'release publish',
    distTagForVersion: version => family.distTagForVersion(version),
  })

  console.log(
    `release publish: family ${family.id}, ${String(order.length)} member(s),`
    + ` ${String(published)} published, ${String(skipped)} already present`,
  )
}

if (isEntry(import.meta.url)) await main()
