/** Native package discovery: the upload order and the workspace version baseline. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeMembers } from './mirror-native.ts'
import { prereleaseDistTag } from './registry.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Create an empty native workspace fixture.
 * @returns The fixture root.
 */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-mirror-'))
  roots.push(root)
  mkdirSync(join(root, 'native/system/packages'), { recursive: true })
  return root
}

/**
 * Write one native package, optionally marked as a platform package.
 * @param root - fixture root.
 * @param directory - package directory under `native/system/packages`.
 * @param manifest - manifest fields to write.
 * @param platform - whether the package carries the platform marker.
 */
function writeNativePackage(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
  platform = false,
): void {
  const packageRoot = join(root, 'native/system/packages', directory)
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`)
  if (platform) writeFileSync(join(packageRoot, 'prebuilds.json'), '{}\n')
}

describe('native release members', () => {
  it('uploads platform packages before the entries that depend on them', () => {
    const root = fixtureRoot()
    writeNativePackage(root, 'entry', { name: '@deepseek-ai/node-addon-system', version: '0.1.2' })
    writeNativePackage(root, 'linux-x64', { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.2' }, true)
    writeNativePackage(root, 'darwin-arm64', { name: '@deepseek-ai/node-addon-system-darwin-arm64', version: '0.1.2' }, true)

    expect(nativeMembers(root).map(member => member.name)).toEqual([
      '@deepseek-ai/node-addon-system-darwin-arm64',
      '@deepseek-ai/node-addon-system-linux-x64',
      '@deepseek-ai/node-addon-system',
    ])
  })

  it('reports each member with its repository-relative directory', () => {
    const root = fixtureRoot()
    writeNativePackage(root, 'linux-x64', { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.2' }, true)

    expect(nativeMembers(root)).toEqual([{
      directory: 'native/system/packages/linux-x64',
      name: '@deepseek-ai/node-addon-system-linux-x64',
      version: '0.1.2',
    }])
  })

  it('refuses a workspace whose packages disagree on the version', () => {
    const root = fixtureRoot()
    writeNativePackage(root, 'entry', { name: '@deepseek-ai/node-addon-system', version: '0.1.2' })
    writeNativePackage(root, 'linux-x64', { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.3' }, true)

    expect(() => nativeMembers(root)).toThrow(/one version/)
  })

  it('skips private packages and refuses a package outside the scope', () => {
    const root = fixtureRoot()
    writeNativePackage(root, 'entry', { name: '@deepseek-ai/node-addon-system', version: '0.1.2' })
    writeNativePackage(root, 'unpublished', { name: '@deepseek-ai/node-addon-system-draft', version: '0.1.2', private: true })
    writeNativePackage(root, 'foreign', { name: 'node-addon-system', version: '0.1.2' })

    expect(() => nativeMembers(root)).toThrow(/@deepseek-ai package/)
    rmSync(join(root, 'native/system/packages/foreign'), { recursive: true })
    expect(nativeMembers(root).map(member => member.name)).toEqual(['@deepseek-ai/node-addon-system'])
  })

  it('refuses a workspace with nothing to publish', () => {
    expect(() => nativeMembers(fixtureRoot())).toThrow(/no publishable native package/)
  })
})

describe('mirrored dist-tags', () => {
  it('sends a prerelease to next and leaves a stable version to latest', () => {
    expect(prereleaseDistTag('0.1.2')).toBeUndefined()
    expect(prereleaseDistTag('0.1.2-rc.1')).toBe('next')
  })
})
