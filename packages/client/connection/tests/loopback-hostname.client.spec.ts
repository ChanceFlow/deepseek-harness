/** Shared loopback-hostname semantics for the Host fence and browser UI. */

import { describe, expect, it } from 'vitest'
import { isLanHostname, isLoopbackHostname } from '../src/loopback-hostname.ts'

describe('isLoopbackHostname', () => {
  it('accepts localhost, IPv6 loopback, and the whole IPv4 127/8 block', () => {
    for (const hostname of ['localhost', '[::1]', '127.0.0.1', '127.8.9.10', '127.255.255.255']) {
      expect(isLoopbackHostname(hostname)).toBe(true)
    }
  })

  it('refuses malformed and non-loopback hostnames', () => {
    for (const hostname of ['remote.localhost', '::1', '128.0.0.1', '127.0.0', '127.0.0.256', '127.0.0.-1']) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })
})

describe('isLanHostname', () => {
  it('accepts private LAN IP blocks and local mDNS hostnames', () => {
    for (const hostname of ['<gitea-host>', '10.0.0.2', '192.168.1.104', '192.168.0.1', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.255', 'nuc.local', 'mybox.lan']) {
      expect(isLanHostname(hostname)).toBe(true)
    }
  })

  it('refuses public IP addresses and non-LAN hostnames', () => {
    for (const hostname of ['192.0.2.20', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', 'example.com', 'localhost']) {
      expect(isLanHostname(hostname)).toBe(false)
    }
  })
})
