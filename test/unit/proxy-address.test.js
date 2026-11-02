// classifyAddress: is this IP on the public internet? (#746)
//
// The cases are the shapes 2026's ip-address advisories found classifiers getting wrong, plus the
// IANA special-purpose blocks: NAT64 (GHSA-2vr4-cq9g-pvrc's 64:ff9b:1::/48, and the well-known
// /96 that embeds an IPv4 address), IPv4-mapped IPv6, leading-zero octets that one parser reads
// as octal and another as decimal, and a CIDR suffix that turns "an address" into "a network".
// The rule under all of them: what is not positively public is not public.
//
// Run: node --test test/unit/proxy-address.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyAddress } = require('../../proxy-address.js');

function expect(table) {
  for (const [address, cls] of table) assert.strictEqual(classifyAddress(address), cls, address);
}

test('public addresses are public', () => {
  expect([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['93.184.215.14', 'public'],
    ['100.63.255.255', 'public'], // just below CGNAT
    ['100.128.0.0', 'public'], // just above it
    ['172.15.255.255', 'public'],
    ['172.32.0.0', 'public'],
    ['192.31.196.1', 'public'], // AS112, globally reachable
    ['223.255.255.255', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['2a00:1450:4001::200e', 'public'],
    ['2001:200::1', 'public'], // just past 2001::/23
    ['3fff:1000::1', 'public'], // just past 3fff::/20
  ]);
});

test('IPv4 special-purpose blocks', () => {
  expect([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.255', 'shared'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.8', 'ietf-protocol'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', '6to4-relay'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ]);
});

test('IPv6 special-purpose blocks; outside 2000::/3 nothing is public', () => {
  expect([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback'],
    ['::127.0.0.1', 'ipv4-compatible'], // deprecated, never decoded
    ['::8.8.8.8', 'ipv4-compatible'],
    ['100::1', 'discard'],
    ['2001::1', 'teredo'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'teredo'],
    ['2001:10::1', 'ietf-protocol'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::', '6to4'],
    ['2002:808:808::1', '6to4'],
    ['3fff::1', 'documentation'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['FE80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['1::', 'reserved'],
    ['4000::1', 'reserved'],
    ['5f00::1', 'reserved'], // SRv6 SIDs
  ]);
});

test('IPv4-mapped IPv6 is classified by the IPv4 address it carries', () => {
  expect([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::FFFF:7F00:0001', 'loopback'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:0.0.0.0', 'unspecified'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:808:808', 'public'],
  ]);
});

test('NAT64: the well-known /96 is classified by its IPv4 address; local-use 64:ff9b:1::/48 is never public', () => {
  expect([
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['64:ff9b::c0a8:101', 'private'],
    ['64:ff9b::808:808', 'public'], // a public site on an IPv6-only network with DNS64
    // GHSA-2vr4-cq9g-pvrc: local-use NAT64 read as an ordinary address.
    ['64:ff9b:1::7f00:1', 'nat64-local'],
    ['64:ff9b:1::808:808', 'nat64-local'],
    ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 'nat64-local'],
    // Outside the /96 but inside 64:ff9b::/32: not the well-known prefix, not public.
    ['64:ff9b:2::7f00:1', 'reserved'],
  ]);
});

test('only canonical numeric strings are addresses: leading zeros, short forms, CIDR suffixes and zones are not', () => {
  expect([
    // Leading-zero octets: octal to inet_aton (0177 = 127), decimal to a naive parser.
    ['0177.0.0.1', 'not-an-ip'],
    ['127.000.000.001', 'not-an-ip'],
    ['010.0.0.1', 'not-an-ip'],
    ['08.8.8.8', 'not-an-ip'],
    // inet_aton's short and numeric forms.
    ['127.1', 'not-an-ip'],
    ['2130706433', 'not-an-ip'],
    ['0x7f.0.0.1', 'not-an-ip'],
    ['0x7f000001', 'not-an-ip'],
    // A CIDR suffix: a network, which a subnet parser may decline to call loopback or private.
    ['127.0.0.1/8', 'not-an-ip'],
    ['10.0.0.0/8', 'not-an-ip'],
    ['::1/128', 'not-an-ip'],
    ['::ffff:127.0.0.1/104', 'not-an-ip'],
    // Zones, brackets, ports, whitespace.
    ['fe80::1%en0', 'not-an-ip'],
    ['::1%lo0', 'not-an-ip'],
    ['[::1]', 'not-an-ip'],
    ['127.0.0.1:80', 'not-an-ip'],
    [' 127.0.0.1', 'not-an-ip'],
    ['127.0.0.1\n', 'not-an-ip'],
    // Out of range, malformed IPv6, a dotted tail that is not a strict quad.
    ['256.0.0.1', 'not-an-ip'],
    ['1.2.3', 'not-an-ip'],
    ['1:2:3:4:5:6:7:8:9', 'not-an-ip'],
    ['::ffff:0177.0.0.1', 'not-an-ip'],
    // Not addresses at all.
    ['localhost', 'not-an-ip'],
    ['', 'not-an-ip'],
    [undefined, 'not-an-ip'],
    [null, 'not-an-ip'],
    [2130706433, 'not-an-ip'],
  ]);
});
