/** Mirrored package discovery: the native upload order, the lockfile pins, and the registry read arguments. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lockedMembers, nativeMembers, vendorMembers } from './mirror-packages.ts'
import { prereleaseDistTag, registrySourceArgs } from './registry.ts'

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

describe('vendored release members', () => {
  /**
   * Write one vendored package.
   * @param root - fixture root.
   * @param directory - package directory under `vendor`.
   * @param manifest - manifest fields to write.
   */
  function writeVendorPackage(root: string, directory: string, manifest: Record<string, unknown>): void {
    const packageRoot = join(root, 'vendor', directory)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`)
  }

  /**
   * Create an empty vendored workspace fixture.
   * @returns The fixture root.
   */
  function vendorRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vendor-mirror-'))
    roots.push(root)
    mkdirSync(join(root, 'vendor'), { recursive: true })
    return root
  }

  it('reads the packages another member depends on first', () => {
    const root = vendorRoot()
    writeVendorPackage(root, 'cordis', { name: '@deepseek-ai/cordis', version: '4.0.4' })
    writeVendorPackage(root, 'plugin-group', {
      name: '@deepseek-ai/cordis-plugin-group',
      version: '1.0.4',
      dependencies: { '@deepseek-ai/cordis': 'workspace:~' },
    })

    expect(vendorMembers(root)).toEqual([
      { name: '@deepseek-ai/cordis', version: '4.0.4' },
      { name: '@deepseek-ai/cordis-plugin-group', version: '1.0.4' },
    ])
  })

  it('skips a private package and refuses a tree with nothing to publish', () => {
    const root = vendorRoot()
    writeVendorPackage(root, 'cordis', { name: '@deepseek-ai/cordis', version: '4.0.4' })
    writeVendorPackage(root, 'draft', { name: '@deepseek-ai/cordis-draft', version: '4.0.4', private: true })

    expect(vendorMembers(root).map(member => member.name)).toEqual(['@deepseek-ai/cordis'])
    expect(() => vendorMembers(vendorRoot())).toThrow(/no publishable vendored package/)
  })
})

describe('lockfile-pinned release members', () => {
  /** A lockfile naming one entry, its platform package, and packages outside the mirrored scope. */
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    "  '@deepseek-ai/office-kit-darwin-arm64@0.1.1':",
    '    resolution: {integrity: sha512-platform}',
    '',
    "  '@deepseek-ai/office-kit@0.1.1':",
    '    resolution: {integrity: sha512-entry}',
    '',
    "  '@deepseek-ai/linked@0.1.1':",
    '    resolution: {directory: packages/linked, type: directory}',
    '',
    "  '@other/package@2.0.0':",
    '    resolution: {integrity: sha512-other}',
    '',
    "  '@deepseek-ai/peered@0.1.1(react@18.3.1)':",
    '    resolution: {integrity: sha512-peered}',
    '',
    'snapshots:',
    '',
    "  '@deepseek-ai/office-kit@0.1.1':",
    '    optionalDependencies:',
    "      '@deepseek-ai/office-kit-darwin-arm64': 0.1.1",
    '',
  ].join('\n')

  it('reads each registry resolution in the mirrored scope, platform packages first', () => {
    expect(lockedMembers(lockfile)).toEqual([
      { name: '@deepseek-ai/office-kit-darwin-arm64', version: '0.1.1', integrity: 'sha512-platform' },
      { name: '@deepseek-ai/office-kit', version: '0.1.1', integrity: 'sha512-entry' },
      { name: '@deepseek-ai/peered', version: '0.1.1', integrity: 'sha512-peered' },
    ])
  })

  it('ignores packages outside the mirrored scope and resolutions that carry no integrity', () => {
    expect(lockedMembers(lockfile).map(member => member.name)).not.toContain('@other/package')
    expect(lockedMembers(lockfile).map(member => member.name)).not.toContain('@deepseek-ai/linked')
  })

  it('reads an empty lockfile as no members', () => {
    expect(lockedMembers("lockfileVersion: '9.0'\n")).toEqual([])
  })
})

describe('registry source arguments', () => {
  it('overrides the scope registry a scoped package would otherwise resolve through', () => {
    expect(registrySourceArgs('@deepseek-ai/office-kit', 'https://registry.npmjs.org')).toEqual([
      '--registry',
      'https://registry.npmjs.org',
      '--@deepseek-ai:registry=https://registry.npmjs.org',
    ])
  })

  it('names only the default registry for an unscoped package', () => {
    expect(registrySourceArgs('typescript', 'https://registry.npmjs.org')).toEqual([
      '--registry',
      'https://registry.npmjs.org',
    ])
  })
})

describe('mirrored dist-tags', () => {
  it('sends a prerelease to next and leaves a stable version to latest', () => {
    expect(prereleaseDistTag('0.1.2')).toBeUndefined()
    expect(prereleaseDistTag('0.1.2-rc.1')).toBe('next')
  })
})
