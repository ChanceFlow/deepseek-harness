/**
 * Browser-safe, zero-dependency loopback and private LAN classification shared
 * by the `/api` Host fence and the package's `ctx.connection` state.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a normalized URL hostname names a private LAN authority (RFC 1918, RFC 6598, or mDNS).
 * @param hostname - WHATWG URL hostname.
 * @returns true for 10/8, 172.16/12, 192.168/16, 100.64/10, or .local/.lan domains.
 */
export function isLanHostname(hostname: string): boolean {
  if (hostname.endsWith('.local') || hostname.endsWith('.lan')) return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  const b0 = Number(parts[0])
  const b1 = Number(parts[1])
  if (b0 === 10) return true
  if (b0 === 192 && b1 === 168) return true
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true
  return false
}
