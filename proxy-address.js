/**
 * Address classifier for /api/proxy's destination policy (#746).
 *
 * classifyAddress(ip) answers one question: is this an address on the public internet? It
 * returns 'public', or the name of the special-use class that makes it not ('loopback',
 * 'private', 'link-local', ...). proxy.js refuses any non-public answer for a URL that neither
 * the user nor an agent chose.
 *
 * It is written as an allowlist, and every input it cannot positively place is non-public:
 *
 *   - IPv4 is public unless it falls in the IANA special-purpose registry.
 *   - IPv6 is public only inside 2000::/3 (global unicast), minus that range's special blocks.
 *     Everything outside it is unallocated or special, and is refused as such.
 *   - The two IPv6 forms that carry an IPv4 address to a real IPv4 destination are classified
 *     by the address they carry: IPv4-mapped (::ffff:a.b.c.d) and well-known NAT64
 *     (64:ff9b::a.b.c.d). Classifying them as IPv6 lets ::ffff:127.0.0.1 and 64:ff9b::7f00:1
 *     through as "not loopback", which is how 2026's ip-address advisories were exploited.
 *   - Local-use NAT64 (64:ff9b:1::/48, RFC 8215) is a network-specific prefix with no fixed
 *     embedding, so it is not decoded. It is non-public outright (GHSA-2vr4-cq9g-pvrc).
 *   - Only canonical numeric strings are addresses. `0177.0.0.1` (octal to inet_aton, decimal to
 *     a naive parser), `127.1`, `2130706433`, `127.0.0.1/8` (a CIDR suffix that a subnet parser
 *     reads as "a network, not an address") and `fe80::1%en0` (a zone) all come back
 *     'not-an-ip'. proxy.js only ever passes what the WHATWG URL parser or getaddrinfo produced,
 *     which are canonical, so this costs nothing and removes the parser-differential class.
 */

const net = require('node:net');

// Strict dotted quad: four decimal octets, 0-255, no leading zeros.
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// [first address, prefix length, class]. IANA IPv4 Special-Purpose Address Registry, minus the
// entries it marks globally reachable (192.31.196.0/24, 192.52.193.0/24, 192.175.48.0/24).
const IPV4_SPECIAL = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared'], // carrier-grade NAT
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], // includes cloud metadata, 169.254.169.254
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // includes 255.255.255.255
].map(([addr, len, cls]) => ({ base: ipv4ToInt(addr), mask: len === 0 ? 0 : (~0 << (32 - len)) >>> 0, cls }));

function ipv4ToInt(s) {
  return s.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

function classifyIPv4Int(n) {
  for (const r of IPV4_SPECIAL) if (((n & r.mask) >>> 0) === r.base) return r.cls;
  return 'public';
}

// Eight 16-bit groups, or null. Accepts what net.isIPv6 accepts, minus zones.
function ipv6Groups(s) {
  if (s.includes('%') || !net.isIPv6(s)) return null;
  // A trailing dotted quad (::ffff:127.0.0.1) becomes its two hex groups.
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!IPV4_RE.test(last)) return null;
    const n = ipv4ToInt(last);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  let groups;
  const dbl = s.indexOf('::');
  if (dbl === -1) {
    groups = parse(s);
  } else {
    const head = parse(s.slice(0, dbl));
    const rest = parse(s.slice(dbl + 2));
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function classifyIPv6(g) {
  const embedded = () => classifyIPv4Int(((g[6] << 16) | g[7]) >>> 0);
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  // ::/96: unspecified, loopback, and the deprecated IPv4-compatible form (never decoded).
  if (zeros(0, 6)) {
    if (g[6] === 0 && g[7] === 0) return 'unspecified';
    if (g[6] === 0 && g[7] === 1) return 'loopback';
    return 'ipv4-compatible';
  }
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(); // ::ffff:0:0/96, IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded(); // 64:ff9b::/96, NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x0001) return 'nat64-local'; // 64:ff9b:1::/48
  if (g[0] === 0x0100 && zeros(1, 4)) return 'discard'; // 100::/64
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation'; // 2001:db8::/32
  if (g[0] === 0x2001 && g[1] === 0x0000) return 'teredo'; // 2001::/32, carries an IPv4 address
  if (g[0] === 0x2001 && g[1] < 0x0200) return 'ietf-protocol'; // 2001::/23
  if (g[0] === 0x2002) return '6to4'; // 2002::/16, carries an IPv4 address
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return 'documentation'; // 3fff::/20
  if ((g[0] & 0xe000) === 0x2000) return 'public'; // 2000::/3
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local'; // fec0::/10, deprecated
  if ((g[0] & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  return 'reserved';
}

function classifyAddress(address) {
  if (typeof address !== 'string') return 'not-an-ip';
  if (IPV4_RE.test(address)) return classifyIPv4Int(ipv4ToInt(address));
  const groups = ipv6Groups(address);
  return groups ? classifyIPv6(groups) : 'not-an-ip';
}

module.exports = { classifyAddress };
