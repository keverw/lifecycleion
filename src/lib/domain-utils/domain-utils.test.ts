import { describe, it, expect } from 'bun:test';
import {
  safeParseURL,
  normalizeDomain,
  normalizeOrigin,
  matchesWildcardDomain,
  matchesWildcardOrigin,
  matchesDomainList,
  matchesOriginList,
  matchesCORSCredentialsList,
  isIPAddress,
  validateConfigEntry,
  parseHostHeader,
  isApexDomain,
} from './domain-utils';
import {
  checkDNSLength,
  matchesMultiLabelPattern,
  matchesWildcardLabels,
  normalizeWildcardPattern,
} from './helpers';

describe('domain-utils', () => {
  describe('safeParseURL', () => {
    it('should return a URL object for valid URLs', () => {
      const parsed = safeParseURL('https://example.com/path?x=1');
      expect(parsed).toBeInstanceOf(URL);
      expect(parsed?.origin).toBe('https://example.com');
      expect(parsed?.hostname).toBe('example.com');
    });

    it('should return null for invalid URLs', () => {
      expect(safeParseURL('not-a-url')).toBeNull();
      expect(safeParseURL('https://')).toBeNull();
    });
  });

  describe('isIPAddress', () => {
    it('should detect IPv4 addresses', () => {
      expect(isIPAddress('192.168.1.1')).toBe(true);
      expect(isIPAddress('127.0.0.1')).toBe(true);
      expect(isIPAddress('10.0.0.1')).toBe(true);
      expect(isIPAddress('255.255.255.255')).toBe(true);
      expect(isIPAddress('0.0.0.0')).toBe(true);
    });

    it('should detect IPv6 addresses', () => {
      expect(isIPAddress('::1')).toBe(true);
      expect(isIPAddress('::')).toBe(true);
      expect(isIPAddress('2001:db8::1')).toBe(true);
      expect(isIPAddress('fe80::1')).toBe(true);
      expect(isIPAddress('[::1]')).toBe(true);
      expect(isIPAddress('[2001:db8::1]')).toBe(true);
    });

    it('should reject non-IP addresses', () => {
      expect(isIPAddress('example.com')).toBe(false);
      expect(isIPAddress('192.168.1.256')).toBe(false);
      expect(isIPAddress('not-an-ip')).toBe(false);
      expect(isIPAddress('192.168.1')).toBe(false);
    });

    it('should reject IPv6 zone-IDs', () => {
      expect(isIPAddress('fe80::1%eth0')).toBe(false);
      expect(isIPAddress('fe80::1%ETH0')).toBe(false);
      expect(isIPAddress('fe80::1%eth0-._~Z9')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0]')).toBe(false);
      expect(isIPAddress('[fe80::1%25ETH0]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0-._~Z9]')).toBe(false);
      expect(isIPAddress('fe80::1%eth0%2D1%3A')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0%2D1%3A]')).toBe(false);
      expect(isIPAddress('fe80::1%')).toBe(false);
      expect(isIPAddress('[fe80::1%25]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0!]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0:]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0%G1]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0%2]')).toBe(false);
      expect(isIPAddress('[fe80::1%25eth0%]')).toBe(false);
    });
  });

  describe('normalizeDomain', () => {
    it('should normalize basic domains', () => {
      expect(normalizeDomain('Example.COM')).toBe('example.com');
      expect(normalizeDomain('API.Example.com')).toBe('api.example.com');
    });

    it('should allow one trailing dot but reject repeated trailing dots', () => {
      expect(normalizeDomain('example.com')).toBe('example.com');
      expect(normalizeDomain('example.com.')).toBe('example.com');
      expect(normalizeDomain('example.com..')).toBe('');
      expect(normalizeDomain('api.example.com.')).toBe('api.example.com');
      expect(normalizeDomain('Example.COM.')).toBe('example.com');
      expect(normalizeDomain('example..')).toBe('');
    });

    it('should handle IP addresses', () => {
      expect(normalizeDomain('192.168.1.1')).toBe('192.168.1.1');
      expect(normalizeDomain('127.0.0.1')).toBe('127.0.0.1');
      expect(normalizeDomain('::1')).toBe('::1');
      expect(normalizeDomain('2001:DB8::1')).toBe('2001:db8::1');
      expect(normalizeDomain('[::1]')).toBe('::1');
    });

    it('should canonicalize equivalent IP literal spellings', () => {
      expect(normalizeDomain('[2001:0db8:0:0:0:0:0:1]')).toBe('2001:db8::1');
      expect(normalizeDomain('0x7f.0.0.1')).toBe('127.0.0.1');
      expect(normalizeDomain('001.002.003.004')).toBe('1.2.3.4');
    });

    it('should handle Unicode normalization', () => {
      // Test NFC normalization
      expect(normalizeDomain('café.com')).toBe('xn--caf-dma.com');
      expect(normalizeDomain('CAFÉ.COM')).toBe('xn--caf-dma.com');
    });

    // cspell:ignore nxasmq münchen mnchen
    it('should handle punycode domains', () => {
      expect(normalizeDomain('xn--nxasmq6b.com')).toBe('xn--nxasmq6b.com');
      expect(normalizeDomain('münchen.de')).toBe('xn--mnchen-3ya.de');
    });

    it('should reject domains with interior empty labels', () => {
      // Interior empty labels should be invalid (a..b should fail)
      expect(normalizeDomain('a..b')).toBe('');
      expect(normalizeDomain('example..com')).toBe('');
      expect(normalizeDomain('api...example.com')).toBe('');
      expect(normalizeDomain('..example.com')).toBe('');

      // Trailing dots should still be allowed (FQDN)
      expect(normalizeDomain('example.com.')).toBe('example.com');
      expect(normalizeDomain('api.example.com.')).toBe('api.example.com');
    });

    it('should return empty string for labels exceeding 63 octets (ASCII)', () => {
      const tooLongLabel = 'a'.repeat(64);
      expect(normalizeDomain(`${tooLongLabel}.com`)).toBe('');
    });

    // cspell:ignore punycoded
    it('should return empty string for punycoded labels exceeding 63 octets (IDN)', () => {
      // Create a Unicode label that becomes >63 chars after punycode
      const longUnicodeLabel = 'café'.repeat(20);
      expect(normalizeDomain(`${longUnicodeLabel}.com`)).toBe('');
    });

    it('should return empty string when total FQDN exceeds 255 octets', () => {
      const label63 = 'a'.repeat(63);
      const domain = [label63, label63, label63, label63, label63].join('.');
      // 5 labels * 63 + 4 dots = 319 > 255
      expect(normalizeDomain(domain)).toBe('');
    });

    it('should handle pathological long IDN patterns in wildcards', () => {
      // Create a very long IDN label that exceeds DNS limits after punycode conversion
      const longUnicodeLabel = 'café'.repeat(20); // 80 chars, will be much longer in punycode
      const pathologicalPattern = `*.${longUnicodeLabel}.com`;

      // normalizeWildcardPattern should detect this and return original pattern
      // The caller (matchesWildcardDomain) will then handle it appropriately
      const doesMatch = matchesWildcardDomain(
        'test.example.com',
        pathologicalPattern,
      );

      expect(doesMatch).toBe(false); // Should not match due to invalid pattern

      // Test with double asterisk pattern
      const pathologicalPattern2 = `**.${longUnicodeLabel}.example.com`;
      const doesMatch2 = matchesWildcardDomain(
        'api.test.example.com',
        pathologicalPattern2,
      );

      expect(doesMatch2).toBe(false); // Should not match due to invalid pattern

      // Test with multiple long labels
      const multiLongPattern = `*.${longUnicodeLabel}.${longUnicodeLabel}.com`;
      const doesMatch3 = matchesWildcardDomain(
        'api.test.example.com',
        multiLongPattern,
      );
      expect(doesMatch3).toBe(false); // Should not match due to invalid pattern
    });

    it('should validate concrete labels in wildcard patterns', () => {
      // Valid patterns should work normally
      expect(matchesWildcardDomain('api.example.com', '*.example.com')).toBe(
        true,
      );
      expect(matchesWildcardDomain('test.café.com', '*.café.com')).toBe(true);

      // Pattern with interior empty labels in concrete parts should fail
      expect(matchesWildcardDomain('api.example.com', '*.example..com')).toBe(
        false,
      );
      expect(
        matchesWildcardDomain('api.test.com', '**.test..example.com'),
      ).toBe(false);

      // Global wildcard pattern should work (no concrete labels to validate)
      expect(matchesWildcardDomain('anything.com', '*')).toBe(true); // Global wildcard now supported
    });

    it('should reject wildcard patterns with a single oversized label', () => {
      // This label becomes > 63 chars after punycode, triggering the early return
      const longLabel = 'a'.repeat(60) + 'é'; // "é"
      const pattern = `*.${longLabel}.com`;

      // The function should return the original pattern, and matching should fail.
      const doesMatch = matchesWildcardDomain('test.whatever.com', pattern);
      expect(doesMatch).toBe(false);
    });

    it('should reject wildcard patterns with a single oversized label (pre-punycode)', () => {
      const longLabel = 'a'.repeat(64);
      const pattern = `*.${longLabel}.com`;

      const doesMatch = matchesWildcardDomain('test.whatever.com', pattern);
      expect(doesMatch).toBe(false);
    });

    it('should accept boundary-length ASCII labels (63) in wildcard patterns', () => {
      const label63 = 'a'.repeat(63);
      const pattern = `*.${label63}.com`;
      expect(matchesWildcardDomain(`x.${label63}.com`, pattern)).toBe(true);
      // Apex should still not match
      expect(matchesWildcardDomain(`${label63}.com`, pattern)).toBe(false);
    });
  });

  // cspell:ignore tést münchen mple Halfwidth
  describe('normalizeOrigin', () => {
    it('should normalize origins with protocol and port', () => {
      expect(normalizeOrigin('https://Example.COM')).toBe(
        'https://example.com',
      );
      expect(normalizeOrigin('http://api.example.com:8080')).toBe(
        'http://api.example.com:8080',
      );
      expect(normalizeOrigin('https://api.example.com:443')).toBe(
        'https://api.example.com',
      );
    });

    it('should handle IP address origins', () => {
      expect(normalizeOrigin('http://192.168.1.1')).toBe('http://192.168.1.1');
      expect(normalizeOrigin('https://127.0.0.1:8080')).toBe(
        'https://127.0.0.1:8080',
      );
      expect(normalizeOrigin('http://[::1]')).toBe('http://[::1]');
      expect(normalizeOrigin('https://[2001:db8::1]:3000')).toBe(
        'https://[2001:db8::1]:3000',
      );
    });

    it('should handle IPv4-mapped IPv6', () => {
      // IPv4-mapped IPv6
      expect(normalizeOrigin('http://[::ffff:192.0.2.128]')).toBe(
        'http://[::ffff:c000:280]',
      );
      expect(normalizeOrigin('https://[::ffff:192.0.2.128]:443')).toBe(
        'https://[::ffff:c000:280]',
      );
      expect(normalizeOrigin('http://[::ffff:192.0.2.128]:8080')).toBe(
        'http://[::ffff:c000:280]:8080',
      );
    });

    it('should canonicalize equivalent IPv6 spellings to the same origin', () => {
      expect(normalizeOrigin('https://[2001:db8::1]')).toBe(
        'https://[2001:db8::1]',
      );
      expect(normalizeOrigin('https://[2001:0db8:0:0:0:0:0:1]')).toBe(
        'https://[2001:db8::1]',
      );
      expect(normalizeOrigin('http://[0:0:0:0:0:0:0:1]')).toBe('http://[::1]');
    });

    it('should handle trailing dots in origins', () => {
      expect(normalizeOrigin('https://example.com.')).toBe(
        'https://example.com',
      );
      expect(normalizeOrigin('http://api.example.com.:8080')).toBe(
        'http://api.example.com:8080',
      );
      expect(normalizeOrigin('https://example.com..')).toBe('');
      expect(normalizeOrigin('http://api.example.com..:8080')).toBe('');
    });

    it("should handle invalid URLs gracefully (empty sentinel, preserve 'null')", () => {
      expect(normalizeOrigin('invalid-url')).toBe('');
      expect(normalizeOrigin('null')).toBe('null');
      expect(normalizeOrigin('https://user:pass@example.com')).toBe('');
      expect(normalizeOrigin('https://example.com/path?x=1')).toBe('');
      expect(normalizeOrigin('https://example.com#frag')).toBe('');
      expect(normalizeOrigin('https://example.com:')).toBe('');
      expect(normalizeOrigin('https://[::1]:')).toBe('');
    });

    it('should reject malformed bracketed hosts', () => {
      expect(normalizeOrigin('https://[not-an-ip]')).toBe('');
      expect(normalizeOrigin('https://[abc]:443')).toBe('');
    });

    it('should normalize an exact origin with a single trailing slash', () => {
      expect(normalizeOrigin('https://example.com/')).toBe(
        'https://example.com',
      );
    });

    it('should reject repeated trailing slashes in origins', () => {
      expect(normalizeOrigin('https://example.com//')).toBe('');
      expect(normalizeOrigin('http://api.example.com:8080///')).toBe('');
    });

    it('should return empty sentinel when hostname normalization fails (pathological IDN)', () => {
      const longUnicodeLabel = 'café'.repeat(20);
      const input = `https://${longUnicodeLabel}.com`;
      // When hostname normalizes to empty sentinel, normalizeOrigin returns empty sentinel
      expect(normalizeOrigin(input)).toBe('');
    });

    it('should reject IPv6 zone-ID origins consistently', () => {
      expect(normalizeOrigin('http://[fe80::1%25eth0]')).toBe('');
      expect(normalizeOrigin('https://[fe80::1%25eth0]:443')).toBe('');
      expect(normalizeOrigin('http://[fe80::1%25ETH0%2D1%3A]:3000')).toBe('');
    });
  });

  describe('matchesWildcardDomain - Smart wildcard matching', () => {
    describe('Global wildcard (*)', () => {
      it("should support global wildcard '*' matching any domain", () => {
        // Global wildcard should match any valid domain
        expect(matchesWildcardDomain('example.com', '*')).toBe(true);
        expect(matchesWildcardDomain('api.example.com', '*')).toBe(true);
        expect(matchesWildcardDomain('sub.domain.example.com', '*')).toBe(true);
        expect(matchesWildcardDomain('localhost', '*')).toBe(true);
        expect(matchesWildcardDomain('test.localhost', '*')).toBe(true);

        // Global wildcard should match IP addresses (special case for global wildcard)
        expect(matchesWildcardDomain('192.168.1.1', '*')).toBe(true);
        expect(matchesWildcardDomain('::1', '*')).toBe(true);

        // Should reject invalid domains
        expect(matchesWildcardDomain('', '*')).toBe(false);
        expect(matchesWildcardDomain('invalid..domain', '*')).toBe(false);
      });

      it("should reject invalid all-wildcard patterns like '*.*'", () => {
        // These patterns should be rejected as invalid
        expect(matchesWildcardDomain('example.com', '*.*')).toBe(false);
        expect(matchesWildcardDomain('api.example.com', '**.*')).toBe(false);
        expect(matchesWildcardDomain('example.com', '*.**')).toBe(false);
        expect(matchesWildcardDomain('example.com', '**.**')).toBe(false);
        expect(matchesWildcardDomain('example.com', 'foo.**')).toBe(false);
      });

      it('should comprehensively test IP address matching with global wildcard', () => {
        // IPv4 addresses
        expect(matchesWildcardDomain('192.168.1.1', '*')).toBe(true);
        expect(matchesWildcardDomain('10.0.0.1', '*')).toBe(true);
        expect(matchesWildcardDomain('172.16.0.1', '*')).toBe(true);
        expect(matchesWildcardDomain('127.0.0.1', '*')).toBe(true);
        expect(matchesWildcardDomain('0.0.0.0', '*')).toBe(true);
        expect(matchesWildcardDomain('255.255.255.255', '*')).toBe(true);

        // IPv6 addresses
        expect(matchesWildcardDomain('::1', '*')).toBe(true);
        expect(matchesWildcardDomain('2001:db8::1', '*')).toBe(true);
        expect(matchesWildcardDomain('fe80::1', '*')).toBe(true);
        expect(matchesWildcardDomain('::ffff:192.168.1.1', '*')).toBe(true);
        expect(
          matchesWildcardDomain('2001:0db8:85a3:0000:0000:8a2e:0370:7334', '*'),
        ).toBe(true);

        // Non-global wildcards should reject IP addresses
        expect(matchesWildcardDomain('192.168.1.1', '*.example.com')).toBe(
          false,
        );
        expect(matchesWildcardDomain('::1', '**.example.com')).toBe(false);
        expect(matchesWildcardDomain('127.0.0.1', '*.*.example.com')).toBe(
          false,
        );
      });

      it('should reject patterns with backslashes (hardening against pasted paths)', () => {
        // Backslashes should be rejected to prevent Windows path confusion
        expect(
          matchesWildcardDomain('example.com', '*.example.com\\path'),
        ).toBe(false);
        expect(
          matchesWildcardDomain('api.example.com', '\\*.example.com'),
        ).toBe(false);
        expect(matchesWildcardDomain('test.com', '*.test\\domain.com')).toBe(
          false,
        );
        expect(matchesWildcardDomain('sub.domain.com', '**\\domain.com')).toBe(
          false,
        );
      });
    });

    describe('Single asterisk (*) - Direct subdomains only', () => {
      it('should match direct subdomains', () => {
        expect(matchesWildcardDomain('api.example.com', '*.example.com')).toBe(
          true,
        );
        expect(matchesWildcardDomain('app.example.com', '*.example.com')).toBe(
          true,
        );
        expect(matchesWildcardDomain('v2.example.com', '*.example.com')).toBe(
          true,
        );
      });

      it('should NOT match nested subdomains', () => {
        expect(
          matchesWildcardDomain('app.api.example.com', '*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardDomain('v2.app.api.example.com', '*.example.com'),
        ).toBe(false);
      });

      it('should NOT match apex domain', () => {
        expect(matchesWildcardDomain('example.com', '*.example.com')).toBe(
          false,
        );
      });

      it('should handle case insensitive matching', () => {
        expect(matchesWildcardDomain('API.Example.COM', '*.example.com')).toBe(
          true,
        );
        expect(matchesWildcardDomain('api.example.com', '*.EXAMPLE.COM')).toBe(
          true,
        );
      });
    });

    describe('Double asterisk (**) - All subdomains including nested', () => {
      it('should match direct subdomains', () => {
        expect(matchesWildcardDomain('api.example.com', '**.example.com')).toBe(
          true,
        );
        expect(matchesWildcardDomain('app.example.com', '**.example.com')).toBe(
          true,
        );
      });

      it('should match nested subdomains with double asterisk', () => {
        expect(matchesWildcardDomain('api.example.com', '**.example.com')).toBe(
          true,
        );
        expect(
          matchesWildcardDomain('app.api.example.com', '**.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'deep.nested.api.example.com',
            '**.example.com',
          ),
        ).toBe(true);
        expect(matchesWildcardDomain('example.com', '**.example.com')).toBe(
          false,
        ); // apex not allowed
      });

      it('should match any prefix before base domain with double asterisk', () => {
        // **.foo.com allows anything before foo.com
        expect(matchesWildcardDomain('api.foo.com', '**.foo.com')).toBe(true);
        expect(matchesWildcardDomain('blog.api.foo.com', '**.foo.com')).toBe(
          true,
        );
        expect(
          matchesWildcardDomain('deep.nested.api.foo.com', '**.foo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('anything.else.foo.com', '**.foo.com'),
        ).toBe(true);
        expect(matchesWildcardDomain('foo.com', '**.foo.com')).toBe(false); // apex not allowed

        // **.blogs.foo.com allows anything before blogs.foo.com
        expect(
          matchesWildcardDomain('a.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('api.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('a.b.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'deep.nested.blogs.foo.com',
            '**.blogs.foo.com',
          ),
        ).toBe(true);
        expect(matchesWildcardDomain('blogs.foo.com', '**.blogs.foo.com')).toBe(
          false,
        ); // ** expects something before the remainder
        expect(matchesWildcardDomain('other.foo.com', '**.blogs.foo.com')).toBe(
          false,
        ); // different subdomain
      });

      it('should support nested wildcard patterns', () => {
        expect(
          matchesWildcardDomain('api.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('v2.api.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true);
        expect(matchesWildcardDomain('blogs.foo.com', '**.blogs.foo.com')).toBe(
          false,
        ); // ** expects something before the remainder
      });

      it('should enforce leftmost ** requires at least one label', () => {
        // Leftmost ** should require at least one domain label before the remainder
        expect(
          matchesWildcardDomain('api.example.com', '**.api.example.com'),
        ).toBe(false); // No labels before "api"
        expect(matchesWildcardDomain('blogs.foo.com', '**.blogs.foo.com')).toBe(
          false,
        ); // No labels before "blogs"
        expect(matchesWildcardDomain('example.com', '**.example.com')).toBe(
          false,
        ); // No labels before "example"

        // But should match when there are labels before the remainder
        expect(
          matchesWildcardDomain(
            'staging.api.example.com',
            '**.api.example.com',
          ),
        ).toBe(true); // "staging" before "api"
        expect(
          matchesWildcardDomain('www.blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(true); // "www" before "blogs"
        expect(
          matchesWildcardDomain(
            'v1.staging.api.example.com',
            '**.api.example.com',
          ),
        ).toBe(true); // "v1.staging" before "api"
      });
    });

    describe('Multi-label wildcard patterns', () => {
      it('should support *.*.example.com patterns', () => {
        // Should match exactly two subdomain levels
        expect(
          matchesWildcardDomain('a.b.example.com', '*.*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('app.api.example.com', '*.*.example.com'),
        ).toBe(true);

        // Should NOT match single level
        expect(
          matchesWildcardDomain('api.example.com', '*.*.example.com'),
        ).toBe(false);

        // Should NOT match three levels
        expect(
          matchesWildcardDomain('x.y.z.example.com', '*.*.example.com'),
        ).toBe(false);

        // Should NOT match apex
        expect(matchesWildcardDomain('example.com', '*.*.example.com')).toBe(
          false,
        );
      });

      it('should support complex multi-label patterns', () => {
        // *.api.*.example.com should match v1.api.staging.example.com
        expect(
          matchesWildcardDomain(
            'v1.api.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'v2.api.prod.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(true);

        // Should NOT match without the fixed "api" label
        expect(
          matchesWildcardDomain(
            'v1.web.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(false);

        // Should NOT match with wrong number of wildcards
        expect(
          matchesWildcardDomain(
            'api.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(false);
        expect(
          matchesWildcardDomain(
            'x.y.api.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(false);
      });

      it('should support mixed * and ** patterns', () => {
        // **.api.example.com should match any depth before "api"
        expect(
          matchesWildcardDomain(
            'v1.staging.api.example.com',
            '**.api.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain('api.example.com', '**.api.example.com'),
        ).toBe(false); // ** expects something before the remainder
        expect(
          matchesWildcardDomain(
            'deep.nested.path.api.example.com',
            '**.api.example.com',
          ),
        ).toBe(true);

        // *.**.example.com should match one label followed by any depth
        expect(
          matchesWildcardDomain(
            'v1.api.staging.example.com',
            '*.**.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain('v1.example.com', '*.**.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'v1.deep.nested.path.example.com',
            '*.**.example.com',
          ),
        ).toBe(true);

        // Should match because it has at least one label
        expect(
          matchesWildcardDomain('api.staging.example.com', '*.**.example.com'),
        ).toBe(true);
      });

      it('should handle edge cases in multi-label patterns', () => {
        // Multiple ** wildcards
        expect(
          matchesWildcardDomain('a.b.c.d.example.com', '**.**.example.com'),
        ).toBe(true);
        // ** patterns require at least one label before the remainder
        // "**.**.example.com" has ambiguous semantics, but should not match apex
        expect(matchesWildcardDomain('example.com', '**.**.example.com')).toBe(
          false,
        );

        // Pattern with more labels than domain
        expect(
          matchesWildcardDomain('api.example.com', '*.*.*.example.com'),
        ).toBe(false);

        // Empty wildcard sections should not match
        expect(
          matchesWildcardDomain('api.example.com', '*.*.example.com'),
        ).toBe(false);
      });
    });

    it('should return false for non-wildcard patterns', () => {
      expect(matchesWildcardDomain('api.example.com', 'example.com')).toBe(
        false,
      );
      expect(matchesWildcardDomain('example.com', 'example.com')).toBe(false);
    });
  });

  describe('matchesWildcardOrigin - Protocol-specific wildcards', () => {
    describe('Global wildcard', () => {
      it("should support global wildcard '*' matching any origin", () => {
        // Global wildcard should match any valid origin
        expect(matchesWildcardOrigin('https://example.com', '*')).toBe(true);
        expect(matchesWildcardOrigin('http://api.example.com', '*')).toBe(true);
        expect(
          matchesWildcardOrigin('https://sub.domain.example.com', '*'),
        ).toBe(true);
        expect(matchesWildcardOrigin('http://localhost:3000', '*')).toBe(true);
        expect(matchesWildcardOrigin('https://192.168.1.1', '*')).toBe(true);
        expect(matchesWildcardOrigin('http://[::1]:8080', '*')).toBe(true);

        // Should still reject non-HTTP(S) schemes
        expect(matchesWildcardOrigin('ftp://example.com', '*')).toBe(false);
        expect(matchesWildcardOrigin('file://example.com', '*')).toBe(false);

        // Should reject invalid origins
        expect(matchesWildcardOrigin('not-a-url', '*')).toBe(false);
        expect(matchesWildcardOrigin('', '*')).toBe(false);
        expect(matchesWildcardOrigin('https://-bad.com', '*')).toBe(false);
        expect(matchesWildcardOrigin('https://example..com', '*')).toBe(false);
        expect(matchesWildcardOrigin('https://example.com:', '*')).toBe(false);
        expect(matchesWildcardOrigin('https://[::1]:', '*')).toBe(false);
      });

      it("should reject invalid all-wildcard patterns like '*.*'", () => {
        // These patterns should be rejected as invalid
        expect(matchesWildcardOrigin('https://example.com', '*.*')).toBe(false);
        expect(matchesWildcardOrigin('https://api.example.com', '**.*')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://example.com', '*.**')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://example.com', '**.**')).toBe(
          false,
        );
      });
    });

    describe('Protocol-only wildcards', () => {
      it('should match https://* for any HTTPS origin', () => {
        expect(matchesWildcardOrigin('https://example.com', 'https://*')).toBe(
          true,
        );
        expect(
          matchesWildcardOrigin('https://api.example.com', 'https://*'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('https://www.api.example.com', 'https://*'),
        ).toBe(true);
        expect(matchesWildcardOrigin('https://localhost', 'https://*')).toBe(
          true,
        );
        expect(matchesWildcardOrigin('https://example.com:', 'https://*')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://[::1]:', 'https://*')).toBe(
          false,
        );
      });

      it('should match http://* for any HTTP origin', () => {
        expect(matchesWildcardOrigin('http://example.com', 'http://*')).toBe(
          true,
        );
        expect(
          matchesWildcardOrigin('http://api.example.com', 'http://*'),
        ).toBe(true);
        expect(matchesWildcardOrigin('http://localhost:3000', 'http://*')).toBe(
          true,
        );
      });

      it('should NOT match https://* for HTTP origins', () => {
        expect(matchesWildcardOrigin('http://example.com', 'https://*')).toBe(
          false,
        );
        expect(
          matchesWildcardOrigin('http://api.example.com', 'https://*'),
        ).toBe(false);
      });

      it('should NOT match http://* for HTTPS origins', () => {
        expect(matchesWildcardOrigin('https://example.com', 'http://*')).toBe(
          false,
        );
        expect(
          matchesWildcardOrigin('https://api.example.com', 'http://*'),
        ).toBe(false);
      });
    });

    describe('Protocol-specific domain wildcards', () => {
      it('should match https://*.example.com for HTTPS subdomains only', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.example.com',
            'https://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://www.example.com',
            'https://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://api.example.com',
            'https://*.example.com',
          ),
        ).toBe(false);
      });

      it('should handle IP address origins with protocol wildcards', () => {
        // Protocol-only wildcards should match IP addresses
        expect(matchesWildcardOrigin('https://192.168.1.1', 'https://*')).toBe(
          true,
        );
        expect(matchesWildcardOrigin('http://127.0.0.1:8080', 'http://*')).toBe(
          true,
        );
        expect(matchesWildcardOrigin('https://[::1]', 'https://*')).toBe(true);
        expect(
          matchesWildcardOrigin('http://[2001:db8::1]:3000', 'http://*'),
        ).toBe(true);

        // Wrong protocol should not match
        expect(matchesWildcardOrigin('http://192.168.1.1', 'https://*')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://127.0.0.1', 'http://*')).toBe(
          false,
        );
      });

      it('should handle trailing dots in wildcard matching', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.example.com.',
            'https://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com',
            'https://*.example.com.',
          ),
        ).toBe(true);
      });

      it('should match http://*.example.com for HTTP subdomains only', () => {
        expect(
          matchesWildcardOrigin(
            'http://api.example.com',
            'http://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://www.example.com',
            'http://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com',
            'http://*.example.com',
          ),
        ).toBe(false);
      });

      it('should support double asterisk with protocol: https://**.example.com', () => {
        expect(
          matchesWildcardOrigin(
            'https://www.api.example.com',
            'https://**.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com',
            'https://**.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://www.api.example.com',
            'https://**.example.com',
          ),
        ).toBe(false);
      });

      it('should NOT match apex domains with protocol-specific wildcards', () => {
        expect(
          matchesWildcardOrigin('https://example.com', 'https://*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('http://example.com', 'http://*.example.com'),
        ).toBe(false);
      });

      it('should reject protocol patterns where domain part has no wildcard or is all-wildcards', () => {
        // No wildcard in domain part: https://example.com is an exact origin, not a wildcard pattern
        expect(
          matchesWildcardOrigin('https://example.com', 'https://example.com'),
        ).toBe(false);
        // All-wildcards domain: https://*.* is too broad
        expect(
          matchesWildcardOrigin('https://example.com', 'https://*.*'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://api.example.com', 'https://**.*'),
        ).toBe(false);
      });

      it('should return false for non-wildcard bare domain passed to wildcard matcher', () => {
        // matchesWildcardOrigin with a bare domain pattern (no *) returns false
        expect(
          matchesWildcardOrigin('https://example.com', 'example.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://api.example.com', 'api.example.com'),
        ).toBe(false);
      });

      it('should handle IPv4-mapped IPv6 with protocol wildcards', () => {
        // Protocol-only wildcards should match valid IPv6 forms
        expect(
          matchesWildcardOrigin('https://[::ffff:192.0.2.128]', 'https://*'),
        ).toBe(true);
        expect(matchesWildcardOrigin('http://[2001:db8::1]', 'http://*')).toBe(
          true,
        );

        // Zone-ID origins are intentionally unsupported
        expect(
          matchesWildcardOrigin('http://[fe80::1%25eth0]', 'http://*'),
        ).toBe(false);

        // Domain wildcards should not match IP literals
        expect(
          matchesWildcardOrigin(
            'https://[::ffff:192.0.2.128]',
            '*.example.com',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('http://[2001:db8::1]', '**.example.com'),
        ).toBe(false);
      });

      it('should handle uppercase wildcard patterns (protocol and host) case-insensitively', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.example.com',
            'HTTPS://**.EXAMPLE.COM',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://www.api.example.com',
            'HTTPS://**.EXAMPLE.COM',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://api.example.com',
            'HTTPS://**.EXAMPLE.COM',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'https://API.EXAMPLE.COM',
            'https://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'HTTPS://API.EXAMPLE.COM',
            'https://*.example.com',
          ),
        ).toBe(true);
      });
    });
  });

  describe('matchesWildcardOrigin - Protocol-agnostic matching', () => {
    describe('Single asterisk (*) - Direct subdomains only', () => {
      it('should match direct subdomains with any protocol', () => {
        expect(
          matchesWildcardOrigin('https://api.example.com', '*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('http://api.example.com', '*.example.com'),
        ).toBe(true);
      });

      it('should NOT match nested subdomains', () => {
        expect(
          matchesWildcardOrigin('https://app.api.example.com', '*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'http://v2.app.api.example.com',
            '*.example.com',
          ),
        ).toBe(false);
      });

      it('should NOT match apex domain', () => {
        expect(
          matchesWildcardOrigin('https://example.com', '*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('http://example.com', '*.example.com'),
        ).toBe(false);
      });

      it('should handle ports correctly', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.example.com:8080',
            '*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('http://api.example.com:3000', '*.example.com'),
        ).toBe(true);
      });

      it('should accept origins with a trailing slash (normalized like bare origin)', () => {
        expect(
          matchesWildcardOrigin('https://api.example.com/', '*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('http://api.example.com/', '*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com/',
            'https://*.example.com',
          ),
        ).toBe(true);
      });

      it('should reject origins with repeated slashes in the path', () => {
        expect(
          matchesWildcardOrigin('https://api.example.com//', '*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com//',
            'https://*.example.com',
          ),
        ).toBe(false);
      });
    });

    describe('Double asterisk (**) - All subdomains including nested', () => {
      it('should match direct subdomains', () => {
        expect(
          matchesWildcardOrigin('https://api.example.com', '**.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('http://app.example.com', '**.example.com'),
        ).toBe(true);
      });

      it('should match nested subdomains', () => {
        expect(
          matchesWildcardOrigin(
            'https://app.api.example.com',
            '**.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://v2.app.api.example.com',
            '**.example.com',
          ),
        ).toBe(true);
      });

      it('should support nested wildcard patterns', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.blogs.foo.com',
            '**.blogs.foo.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://v2.api.blogs.foo.com',
            '**.blogs.foo.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('https://blogs.foo.com', '**.blogs.foo.com'),
        ).toBe(false);
      });
    });

    it('should handle invalid origins gracefully', () => {
      expect(matchesWildcardOrigin('invalid-url', '*.example.com')).toBe(false);
      expect(matchesWildcardOrigin('null', '*.example.com')).toBe(false);
    });

    it('should return false for non-wildcard patterns', () => {
      expect(
        matchesWildcardOrigin('https://api.example.com', 'example.com'),
      ).toBe(false);
    });
  });

  // New tests for security hardening guards
  describe('Wildcard hardening - security guards', () => {
    it('should reject non-HTTP(S) schemes in origin wildcard matching', () => {
      expect(
        matchesWildcardOrigin('ws://api.example.com', '*.example.com'),
      ).toBe(false);
      expect(matchesWildcardOrigin('ftp://example.com', 'https://*')).toBe(
        false,
      );
      expect(
        matchesWildcardOrigin('chrome-extension://abcd', 'https://*'),
      ).toBe(false);
      expect(matchesWildcardOrigin('file:///etc/hosts', 'http://*')).toBe(
        false,
      );
    });

    it('should prevent wildcard matching of IP addresses in domain wildcards', () => {
      expect(matchesWildcardDomain('127.0.0.1', '*.0.0.1')).toBe(false);
      expect(matchesWildcardDomain('127.0.0.1', '**.example.com')).toBe(false);
      expect(matchesWildcardDomain('[::1]', '*.example.com')).toBe(false);
      expect(
        matchesWildcardDomain('[::ffff:192.0.2.128]', '**.example.com'),
      ).toBe(false);
    });

    it('should reject wildcard patterns with ports/paths/query/fragment/brackets (domain)', () => {
      expect(
        matchesWildcardDomain('api.example.com', '*.example.com:8080'),
      ).toBe(false);
      expect(
        matchesWildcardDomain('api.example.com', '*.example.com/path'),
      ).toBe(false);
      expect(
        matchesWildcardDomain('api.example.com', '*.example.com?x=1'),
      ).toBe(false);
      expect(
        matchesWildcardDomain('api.example.com', '*.example.com#frag'),
      ).toBe(false);
      expect(matchesWildcardDomain('api.example.com', '**.[::1]')).toBe(false);
    });

    it('should reject wildcard patterns with ports/paths/query/fragment/brackets in protocol-specific origin patterns', () => {
      expect(
        matchesWildcardOrigin(
          'https://api.example.com',
          'https://*.example.com:8080',
        ),
      ).toBe(false);
      expect(
        matchesWildcardOrigin(
          'https://api.example.com',
          'https://*.example.com/path',
        ),
      ).toBe(false);
      expect(
        matchesWildcardOrigin(
          'https://api.example.com',
          'https://*.example.com?x=1',
        ),
      ).toBe(false);
      expect(
        matchesWildcardOrigin(
          'https://api.example.com',
          'https://*.example.com#frag',
        ),
      ).toBe(false);
      expect(matchesWildcardOrigin('https://[::1]', 'https://**.[::1]')).toBe(
        false,
      );
    });

    it('should reject wildcard patterns that target public suffixes (PSL tails)', () => {
      // Domain wildcard patterns with a fixed tail equal to a public suffix must be rejected
      expect(matchesWildcardDomain('api.com', '*.com')).toBe(false);
      expect(matchesWildcardDomain('a.b.co.uk', '**.co.uk')).toBe(false);
      expect(matchesWildcardDomain('x.y.z.net', '*.*.net')).toBe(false);
      expect(matchesWildcardDomain('api.com', 'api.*.com')).toBe(false);
      expect(matchesWildcardDomain('app.127.0.0.1', '*.127.0.0.1')).toBe(false);

      // Protocol-specific origin patterns should inherit the same PSL guard via domain-utils
      expect(matchesWildcardOrigin('https://api.com', '*.com')).toBe(false);
      expect(matchesWildcardOrigin('https://a.b.co.uk', '**.co.uk')).toBe(
        false,
      );
      expect(matchesWildcardOrigin('https://x.y.z.net', '*.*.net')).toBe(false);

      // Pseudo-TLD tails follow the same wildcard guard as public suffixes.
      expect(matchesWildcardDomain('api.localhost', '*.localhost')).toBe(false);
      expect(
        matchesWildcardOrigin('https://api.localhost', '*.localhost'),
      ).toBe(false);
      expect(matchesWildcardDomain('api.test', '*.test')).toBe(false);
      expect(matchesWildcardDomain('myapp.local', '*.local')).toBe(false);
      expect(matchesWildcardDomain('api.internal', '*.internal')).toBe(false);

      // Apex pseudo-TLD should not match wildcard either (must be explicit)
      expect(matchesWildcardDomain('localhost', '*.localhost')).toBe(false);
    });
  });

  describe('matchesDomainList', () => {
    it('should match exact domains', () => {
      expect(
        matchesDomainList('example.com', ['example.com', 'test.com']),
      ).toBe(true);
      expect(matchesDomainList('test.com', ['example.com', 'test.com'])).toBe(
        true,
      );
      expect(matchesDomainList('other.com', ['example.com', 'test.com'])).toBe(
        false,
      );
    });

    it('should reject exact public suffix entries at runtime', () => {
      expect(matchesDomainList('com', ['com'])).toBe(false);
      expect(matchesDomainList('co.uk', ['co.uk'])).toBe(false);
      expect(matchesDomainList('localhost', ['localhost'])).toBe(true);
      expect(matchesDomainList('127.0.0.1', ['127.0.0.1'])).toBe(true);
    });

    it('should match single asterisk wildcard domains', () => {
      expect(matchesDomainList('api.example.com', ['*.example.com'])).toBe(
        true,
      );
      expect(matchesDomainList('app.api.example.com', ['*.example.com'])).toBe(
        false,
      ); // nested not allowed
      expect(matchesDomainList('example.com', ['*.example.com'])).toBe(false);
    });

    it('should match double asterisk wildcard domains', () => {
      expect(matchesDomainList('api.example.com', ['**.example.com'])).toBe(
        true,
      );
      expect(matchesDomainList('app.api.example.com', ['**.example.com'])).toBe(
        true,
      ); // nested allowed
      expect(matchesDomainList('example.com', ['**.example.com'])).toBe(false);
    });

    it('should support mixed exact and wildcard patterns', () => {
      const domains = ['example.com', '*.api.example.com', 'test.com'];
      expect(matchesDomainList('example.com', domains)).toBe(true);
      expect(matchesDomainList('v1.api.example.com', domains)).toBe(true); // direct subdomain
      expect(matchesDomainList('app.v1.api.example.com', domains)).toBe(false); // nested not allowed with *
      expect(matchesDomainList('api.example.com', domains)).toBe(false); // apex of wildcard
      expect(matchesDomainList('test.com', domains)).toBe(true);
    });

    it('should throw on origin-style patterns in domain lists', () => {
      // Alone, an origin-style wildcard should cause a throw
      expect(() =>
        matchesDomainList('api.example.com', ['https://*.example.com']),
      ).toThrowError(/origin-style patterns are not allowed/i);

      // When combined with a proper domain wildcard, it should still throw
      expect(() =>
        matchesDomainList('api.example.com', [
          'https://*.example.com',
          '*.example.com',
        ]),
      ).toThrowError(/origin-style patterns are not allowed/i);

      // Mixed protocol-specific origin patterns should also throw
      expect(() =>
        matchesDomainList('app.api.example.com', [
          'http://**.example.com',
          'https://**.example.com',
        ]),
      ).toThrowError(/origin-style patterns are not allowed/i);
    });

    it('should throw on non-wildcard origin entries', () => {
      expect(() =>
        matchesDomainList('example.com', ['https://example.com']),
      ).toThrowError(/origin-style patterns are not allowed/i);
      expect(() =>
        matchesDomainList('example.com', ['http://example.com']),
      ).toThrowError(/origin-style patterns are not allowed/i);
    });

    it('should trim and skip empty entries', () => {
      expect(
        matchesDomainList('api.example.com', ['  ', '\t\n', '*.example.com']),
      ).toBe(true);
    });

    it('should early-return false for invalid input domains', () => {
      expect(matchesDomainList('   ', ['*.example.com'])).toBe(false);
      expect(matchesDomainList('\t\n', ['example.com'])).toBe(false);
    });

    it('should match canonical-equivalent IP literals in exact domain entries', () => {
      expect(
        matchesDomainList('[2001:db8::1]', ['[2001:0db8:0:0:0:0:0:1]']),
      ).toBe(true);
      expect(matchesDomainList('127.0.0.1', ['0x7f.0.0.1'])).toBe(true);
    });
  });

  describe('matchesOriginList', () => {
    it("should support global wildcard '*' in origin lists", () => {
      const allowedOrigins = ['*'];

      // Global wildcard should match any valid origin
      expect(matchesOriginList('https://example.com', allowedOrigins)).toBe(
        true,
      );
      expect(matchesOriginList('http://api.example.com', allowedOrigins)).toBe(
        true,
      );
      expect(
        matchesOriginList('https://sub.domain.example.com', allowedOrigins),
      ).toBe(true);
      expect(matchesOriginList('http://localhost:3000', allowedOrigins)).toBe(
        true,
      );
      expect(matchesOriginList('https://192.168.1.1', allowedOrigins)).toBe(
        true,
      );

      // Should reject undefined/null origins by default
      expect(matchesOriginList(undefined, allowedOrigins)).toBe(false);
      expect(matchesOriginList('', allowedOrigins)).toBe(false);
    });

    it('should support treatNoOriginAsAllowed option with global wildcard', () => {
      const allowedOrigins = ['*'];

      // With treatNoOriginAsAllowed: true, undefined origins should be allowed when "*" is present
      expect(
        matchesOriginList(undefined, allowedOrigins, {
          treatNoOriginAsAllowed: true,
        }),
      ).toBe(true);

      // Without the option, should still reject
      expect(
        matchesOriginList(undefined, allowedOrigins, {
          treatNoOriginAsAllowed: false,
        }),
      ).toBe(false);
      expect(matchesOriginList(undefined, allowedOrigins)).toBe(false); // default behavior
    });

    it('should require global wildcard for treatNoOriginAsAllowed to work', () => {
      const allowedOriginsWithoutWildcard = [
        'https://example.com',
        'http://api.com',
      ];

      // Even with treatNoOriginAsAllowed: true, should reject if no "*" in the list
      expect(
        matchesOriginList(undefined, allowedOriginsWithoutWildcard, {
          treatNoOriginAsAllowed: true,
        }),
      ).toBe(false);

      const allowedOriginsWithWildcard = [
        'https://example.com',
        '*',
        'http://api.com',
      ];

      // Should allow when "*" is present
      expect(
        matchesOriginList(undefined, allowedOriginsWithWildcard, {
          treatNoOriginAsAllowed: true,
        }),
      ).toBe(true);
      expect(matchesOriginList('', allowedOriginsWithWildcard)).toBe(false);
    });

    it('should work with mixed patterns including global wildcard', () => {
      const allowedOrigins = ['https://example.com', '*', '*.api.com'];

      // All should match due to global wildcard
      expect(matchesOriginList('https://example.com', allowedOrigins)).toBe(
        true,
      );
      expect(matchesOriginList('http://different.com', allowedOrigins)).toBe(
        true,
      );
      expect(matchesOriginList('https://test.api.com', allowedOrigins)).toBe(
        true,
      );
    });

    it('should reject invalid all-wildcard patterns in origin lists', () => {
      // These should not match due to invalid patterns
      expect(matchesOriginList('https://example.com', ['*.*'])).toBe(false);
      expect(matchesOriginList('https://example.com', ['**.*'])).toBe(false);
      expect(matchesOriginList('https://example.com', ['*.**'])).toBe(false);
    });
    it('should match exact origins', () => {
      const origins = ['https://example.com', 'http://test.com'];
      expect(matchesOriginList('https://example.com', origins)).toBe(true);
      expect(matchesOriginList('http://test.com', origins)).toBe(true);
      expect(matchesOriginList('https://other.com', origins)).toBe(false);
    });

    it('should match exact non-http origins and ignore blank entries', () => {
      expect(
        matchesOriginList('ftp://example.com', [
          '  ',
          '\t',
          'ftp://example.com',
        ]),
      ).toBe(true);
      expect(
        matchesOriginList('ftp://other.com', ['  ', '\t', 'ftp://example.com']),
      ).toBe(false);
    });

    it('should match exact origins with non-default ports exactly', () => {
      expect(
        matchesOriginList('https://example.com:8443', [
          'https://example.com:8443',
        ]),
      ).toBe(true);
      expect(
        matchesOriginList('https://example.com:9443', [
          'https://example.com:8443',
        ]),
      ).toBe(false);
    });

    it('should reject exact public suffix allowlist entries at runtime', () => {
      expect(matchesOriginList('https://com', ['https://com'])).toBe(false);
      expect(matchesOriginList('https://co.uk', ['https://co.uk'])).toBe(false);
      expect(
        matchesOriginList('https://localhost', ['https://localhost']),
      ).toBe(true);
    });

    it('should match single asterisk wildcard origins', () => {
      const origins = ['*.example.com'];
      expect(matchesOriginList('https://api.example.com', origins)).toBe(true);
      expect(matchesOriginList('http://api.example.com', origins)).toBe(true);
      expect(matchesOriginList('https://app.api.example.com', origins)).toBe(
        false,
      ); // nested not allowed
      expect(matchesOriginList('https://example.com', origins)).toBe(false);
    });

    it('should match double asterisk wildcard origins', () => {
      const origins = ['**.example.com'];
      expect(matchesOriginList('https://api.example.com', origins)).toBe(true);
      expect(matchesOriginList('https://app.api.example.com', origins)).toBe(
        true,
      ); // nested allowed
      expect(matchesOriginList('https://example.com', origins)).toBe(false);
    });

    it('should handle undefined origin', () => {
      expect(matchesOriginList(undefined, ['*.example.com'])).toBe(false);
    });

    it('should reject exact allowlist entries with userinfo or URL suffixes', () => {
      expect(
        matchesOriginList('https://example.com', [
          'https://user:pass@example.com',
        ]),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com', [
          'https://example.com/path?x=1#frag',
        ]),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com', ['https://example.com/']),
      ).toBe(true);
      expect(
        matchesOriginList('https://example.com//', ['https://example.com']),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com', ['https://example.com//']),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com', ['https://example.com:']),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com?x=1', ['https://example.com']),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com#frag', ['https://example.com']),
      ).toBe(false);
    });

    it('should allow bare-domain allowlist entries to match origin hostnames', () => {
      expect(matchesOriginList('https://example.com', ['example.com'])).toBe(
        true,
      );
      expect(
        matchesOriginList('http://example.com:8080', ['example.com']),
      ).toBe(true);
      expect(
        matchesOriginList('https://api.example.com', ['example.com']),
      ).toBe(false);
    });

    it('should canonicalize bare-domain IP allowlist entries for origin matching', () => {
      expect(matchesOriginList('http://127.0.0.1', ['0x7f.0.0.1'])).toBe(true);
      expect(
        matchesOriginList('http://[2001:db8::1]', ['[2001:0db8:0:0:0:0:0:1]']),
      ).toBe(true);
    });

    it('should support nested wildcard patterns with double asterisk', () => {
      const origins = ['**.blogs.foo.com'];
      expect(matchesOriginList('https://api.blogs.foo.com', origins)).toBe(
        true,
      );
      expect(matchesOriginList('https://v2.api.blogs.foo.com', origins)).toBe(
        true,
      );
      expect(matchesOriginList('https://blogs.foo.com', origins)).toBe(false);
    });

    it('should NOT match nested with single asterisk', () => {
      const origins = ['*.blogs.foo.com'];
      expect(matchesOriginList('https://api.blogs.foo.com', origins)).toBe(
        true,
      ); // direct subdomain
      expect(matchesOriginList('https://v2.api.blogs.foo.com', origins)).toBe(
        false,
      ); // nested not allowed
      expect(matchesOriginList('https://blogs.foo.com', origins)).toBe(false);
    });
  });

  describe('matchesCORSCredentialsList', () => {
    it('should match exact origins in credentials list', () => {
      const allowedOrigins = ['https://example.com', 'https://api.example.com'];
      expect(
        matchesCORSCredentialsList('https://example.com', allowedOrigins),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://api.example.com', allowedOrigins),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://other.com', allowedOrigins),
      ).toBe(false);
    });

    it('should match exact non-http origins in credentials lists and ignore blank entries', () => {
      expect(
        matchesCORSCredentialsList('ftp://example.com', [
          '  ',
          '\t',
          'ftp://example.com',
        ]),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('ftp://other.com', [
          '  ',
          '\t',
          'ftp://example.com',
        ]),
      ).toBe(false);
    });

    it('should match exact origins with non-default ports in credentials list', () => {
      expect(
        matchesCORSCredentialsList('https://example.com:8443', [
          'https://example.com:8443',
        ]),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://example.com:9443', [
          'https://example.com:8443',
        ]),
      ).toBe(false);
    });

    it('should reject exact public suffix allowlist entries in credentials mode', () => {
      expect(matchesCORSCredentialsList('https://com', ['https://com'])).toBe(
        false,
      );
      expect(
        matchesCORSCredentialsList('https://co.uk', ['https://co.uk']),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://localhost', ['https://localhost']),
      ).toBe(true);
    });

    it('should handle case-insensitive matching', () => {
      const allowedOrigins = ['https://Example.COM'];
      expect(
        matchesCORSCredentialsList('https://example.com', allowedOrigins),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('HTTPS://EXAMPLE.COM', allowedOrigins),
      ).toBe(true);
    });

    it('should return false for undefined origin', () => {
      const allowedOrigins = ['https://example.com'];
      expect(matchesCORSCredentialsList(undefined, allowedOrigins)).toBe(false);
    });

    it('should handle port normalization', () => {
      const allowedOrigins = [
        'https://example.com:443',
        'http://api.example.com:80',
      ];
      expect(
        matchesCORSCredentialsList('https://example.com', allowedOrigins),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('http://api.example.com', allowedOrigins),
      ).toBe(true);
    });

    it('should not support wildcards for security', () => {
      const allowedOrigins = ['*.example.com'];
      expect(
        matchesCORSCredentialsList('https://api.example.com', allowedOrigins),
      ).toBe(false);
      expect(matchesCORSCredentialsList('*.example.com', allowedOrigins)).toBe(
        false,
      );
    });

    it('should reject malformed origins and malformed exact allowlist entries', () => {
      expect(matchesCORSCredentialsList('not-a-url', ['also-bad'])).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com', ['also-bad']),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('not-a-url', ['https://example.com']),
      ).toBe(false);
    });

    it('should reject exact credentials allowlist entries with userinfo or URL suffixes', () => {
      expect(
        matchesCORSCredentialsList('https://example.com', [
          'https://user:pass@example.com',
        ]),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com', [
          'https://example.com/path?x=1#frag',
        ]),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com', [
          'https://example.com/',
        ]),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://example.com', [
          'https://example.com:',
        ]),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com?x=1', [
          'https://example.com',
        ]),
      ).toBe(false);
      expect(matchesCORSCredentialsList('https://example.com', ['null'])).toBe(
        false,
      );
    });
  });

  describe('matchesCORSCredentialsList (unified)', () => {
    it('supports exact-only by default', () => {
      const allowed = [
        'https://admin.example.com',
        'https://console.example.com',
      ];
      expect(
        matchesCORSCredentialsList('https://admin.example.com', allowed),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://sub.admin.example.com', allowed),
      ).toBe(false);
    });

    it('supports *.example.com — direct subdomains only', () => {
      const allowed = ['https://*.example.com', 'https://partner.io'];
      expect(
        matchesCORSCredentialsList('https://admin.example.com', allowed, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://deep.admin.example.com', allowed, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false); // *.example.com is direct subdomains only
      expect(
        matchesCORSCredentialsList('https://example.com', allowed, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false); // apex not matched
    });

    it('supports **.example.com — all subdomain depths', () => {
      const allowed = ['**.example.com'];
      const opts = { allowWildcardSubdomains: true };
      expect(
        matchesCORSCredentialsList('https://admin.example.com', allowed, opts),
      ).toBe(true); // one level
      expect(
        matchesCORSCredentialsList(
          'https://deep.admin.example.com',
          allowed,
          opts,
        ),
      ).toBe(true); // two levels
      expect(
        matchesCORSCredentialsList('https://a.b.c.example.com', allowed, opts),
      ).toBe(true); // three levels
      expect(
        matchesCORSCredentialsList('https://example.com', allowed, opts),
      ).toBe(false); // apex not matched
    });

    it('supports *.*.example.com — exactly two subdomain levels', () => {
      const allowed = ['*.*.example.com'];
      const opts = { allowWildcardSubdomains: true };
      expect(
        matchesCORSCredentialsList('https://a.b.example.com', allowed, opts),
      ).toBe(true); // exactly two levels
      expect(
        matchesCORSCredentialsList(
          'https://app.api.example.com',
          allowed,
          opts,
        ),
      ).toBe(true); // exactly two levels
      expect(
        matchesCORSCredentialsList('https://api.example.com', allowed, opts),
      ).toBe(false); // only one level
      expect(
        matchesCORSCredentialsList('https://x.y.z.example.com', allowed, opts),
      ).toBe(false); // three levels
      expect(
        matchesCORSCredentialsList('https://example.com', allowed, opts),
      ).toBe(false); // apex not matched
    });

    it('supports https://*.example.com and https://**.example.com with explicit protocol', () => {
      const opts = { allowWildcardSubdomains: true };
      // Single-star with protocol: direct only
      expect(
        matchesCORSCredentialsList(
          'https://api.example.com',
          ['https://*.example.com'],
          opts,
        ),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList(
          'https://deep.api.example.com',
          ['https://*.example.com'],
          opts,
        ),
      ).toBe(false);
      // Double-star with protocol: all depths
      expect(
        matchesCORSCredentialsList(
          'https://deep.api.example.com',
          ['https://**.example.com'],
          opts,
        ),
      ).toBe(true);
      // Protocol mismatch
      expect(
        matchesCORSCredentialsList(
          'http://api.example.com',
          ['https://*.example.com'],
          opts,
        ),
      ).toBe(false);
    });

    it('rejects global and protocol wildcards in credentials mode', () => {
      expect(
        matchesCORSCredentialsList('https://attacker.example', ['*'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://attacker.example', ['https://*'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });

    it('supports bare-domain allowlist entries as host checks', () => {
      expect(
        matchesCORSCredentialsList('https://example.com', ['example.com']),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('http://example.com:8443', ['example.com']),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('https://api.example.com', ['example.com']),
      ).toBe(false);
    });

    it('supports canonical-equivalent IP literals in bare-domain credential entries', () => {
      expect(
        matchesCORSCredentialsList('http://127.0.0.1', ['0x7f.0.0.1']),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('http://[2001:db8::1]', [
          '[2001:0db8:0:0:0:0:0:1]',
        ]),
      ).toBe(true);
    });

    it('supports bare-domain wildcard entries for direct subdomains when enabled', () => {
      expect(
        matchesCORSCredentialsList(
          'https://api.example.com',
          ['*.example.com'],
          {
            allowWildcardSubdomains: true,
          },
        ),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList(
          'https://deep.api.example.com',
          ['*.example.com'],
          {
            allowWildcardSubdomains: true,
          },
        ),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com', ['*.example.com'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });

    it('matches credential allowlists across equivalent IPv6 spellings', () => {
      expect(
        matchesCORSCredentialsList('https://[2001:db8::1]', [
          'https://[2001:0db8:0:0:0:0:0:1]',
        ]),
      ).toBe(true);
      expect(
        matchesCORSCredentialsList('http://[::1]', [
          'http://[0:0:0:0:0:0:0:1]',
        ]),
      ).toBe(true);
    });
  });

  describe('Edge Cases and Advanced Scenarios', () => {
    describe('IDN (Internationalized Domain Names) + Wildcard', () => {
      it('should handle punycode conversion in wildcard patterns', () => {
        // Test that IDN domains are properly converted to punycode for matching
        expect(matchesWildcardDomain('tést.例え.com', '*.例え.com')).toBe(true);
        expect(matchesWildcardDomain('café.münchen.de', '*.münchen.de')).toBe(
          true,
        );
        expect(
          matchesWildcardDomain('api.xn--nxasmq6b.com', '*.xn--nxasmq6b.com'),
        ).toBe(true);

        // Mixed IDN and ASCII
        expect(matchesWildcardDomain('api.例え.com', '*.例え.com')).toBe(true);
        expect(matchesWildcardDomain('tést.example.com', '*.example.com')).toBe(
          true,
        );

        // Should work with origins too
        expect(
          matchesWildcardOrigin('https://tést.例え.com', '*.例え.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('https://café.münchen.de', '*.münchen.de'),
        ).toBe(true);
      });

      it('should handle IDN with double asterisk patterns', () => {
        expect(matchesWildcardDomain('sub.tést.例え.com', '**.例え.com')).toBe(
          true,
        );
        expect(
          matchesWildcardDomain('deep.nested.café.münchen.de', '**.münchen.de'),
        ).toBe(true);

        // Apex should still not match
        expect(matchesWildcardDomain('例え.com', '**.例え.com')).toBe(false);
        expect(matchesWildcardDomain('münchen.de', '**.münchen.de')).toBe(
          false,
        );
      });
    });

    describe('Apex Exclusions with Complex TLDs', () => {
      it('should handle apex exclusions with country code TLDs', () => {
        // Single asterisk should not match apex
        expect(matchesWildcardDomain('example.co.uk', '*.example.co.uk')).toBe(
          false,
        );
        expect(
          matchesWildcardDomain('example.com.au', '*.example.com.au'),
        ).toBe(false);
        expect(
          matchesWildcardDomain('example.org.nz', '*.example.org.nz'),
        ).toBe(false);

        // But should match direct subdomains
        expect(
          matchesWildcardDomain('api.example.co.uk', '*.example.co.uk'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('www.example.com.au', '*.example.com.au'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('blog.example.org.nz', '*.example.org.nz'),
        ).toBe(true);
      });

      it('should handle double asterisk apex exclusions with complex TLDs', () => {
        // Double asterisk should not match apex
        expect(matchesWildcardDomain('example.co.uk', '**.example.co.uk')).toBe(
          false,
        );
        expect(
          matchesWildcardDomain('example.com.au', '**.example.com.au'),
        ).toBe(false);

        // But should match subdomains at any depth
        expect(
          matchesWildcardDomain('a.example.co.uk', '**.example.co.uk'),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'api.staging.example.co.uk',
            '**.example.co.uk',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'deep.nested.api.example.com.au',
            '**.example.com.au',
          ),
        ).toBe(true);
      });

      it('should handle origins with complex TLD apex exclusions', () => {
        // Origin matching should follow same rules
        expect(
          matchesWildcardOrigin('https://example.co.uk', '*.example.co.uk'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://example.co.uk', '**.example.co.uk'),
        ).toBe(false);

        expect(
          matchesWildcardOrigin('https://api.example.co.uk', '*.example.co.uk'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://api.staging.example.co.uk',
            '**.example.co.uk',
          ),
        ).toBe(true);
      });
    });

    describe('Multi-Wildcards Edge Cases', () => {
      it('should handle *.api.*.example.com patterns correctly', () => {
        // Should match when both wildcards have exactly one label
        expect(
          matchesWildcardDomain('x.api.y.example.com', '*.api.*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'v1.api.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'prod.api.west.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(true);

        // Should NOT match when first wildcard is missing (leading * needs 1 label)
        expect(
          matchesWildcardDomain('api.y.example.com', '*.api.*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardDomain(
            'api.staging.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(false);

        // Should NOT match when second wildcard is missing
        expect(
          matchesWildcardDomain('x.api.example.com', '*.api.*.example.com'),
        ).toBe(false);

        // Should NOT match when either wildcard has multiple labels
        expect(
          matchesWildcardDomain('a.b.api.y.example.com', '*.api.*.example.com'),
        ).toBe(false);
        expect(
          matchesWildcardDomain('x.api.a.b.example.com', '*.api.*.example.com'),
        ).toBe(false);
      });

      it('should handle mixed * and ** in multi-wildcard patterns', () => {
        // **.api.*.example.com - any depth before api, exactly one after
        expect(
          matchesWildcardDomain(
            'deep.nested.api.staging.example.com',
            '**.api.*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'v1.api.prod.example.com',
            '**.api.*.example.com',
          ),
        ).toBe(true);

        // Should not match when second wildcard has multiple labels
        expect(
          matchesWildcardDomain(
            'v1.api.a.b.example.com',
            '**.api.*.example.com',
          ),
        ).toBe(false);

        // *.api.**.example.com - exactly one before api, any depth after
        expect(
          matchesWildcardDomain(
            'v1.api.staging.west.example.com',
            '*.api.**.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardDomain(
            'prod.api.deep.nested.path.example.com',
            '*.api.**.example.com',
          ),
        ).toBe(true);

        // Should not match when first wildcard has multiple labels
        expect(
          matchesWildcardDomain(
            'a.b.api.staging.example.com',
            '*.api.**.example.com',
          ),
        ).toBe(false);
      });

      it('should handle origin matching with multi-wildcards', () => {
        // Should work with origins too
        expect(
          matchesWildcardOrigin(
            'https://x.api.y.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://api.y.example.com',
            '*.api.*.example.com',
          ),
        ).toBe(false);

        // Protocol-specific multi-wildcards
        expect(
          matchesWildcardOrigin(
            'https://x.api.y.example.com',
            'https://*.api.*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://x.api.y.example.com',
            'https://*.api.*.example.com',
          ),
        ).toBe(false);
      });

      it('should support *.bar.*.demo.com pattern precisely', () => {
        // Domain matching
        expect(
          matchesWildcardDomain('x.bar.y.demo.com', '*.bar.*.demo.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('api.bar.stg.demo.com', '*.bar.*.demo.com'),
        ).toBe(true);

        // Missing first * (needs exactly one label before bar)
        expect(
          matchesWildcardDomain('bar.y.demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
        // Missing second * (needs exactly one label between bar and demo.com)
        expect(
          matchesWildcardDomain('x.bar.demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
        // Too many labels for the second *
        expect(
          matchesWildcardDomain('x.bar.a.b.demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
        // Apex should never match
        expect(matchesWildcardDomain('demo.com', '*.bar.*.demo.com')).toBe(
          false,
        );

        // Origin matching (protocol-agnostic host pattern)
        expect(
          matchesWildcardOrigin('https://x.bar.y.demo.com', '*.bar.*.demo.com'),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'http://api.bar.stg.demo.com',
            '*.bar.*.demo.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin('https://bar.y.demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://x.bar.demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'https://x.bar.a.b.demo.com',
            '*.bar.*.demo.com',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://demo.com', '*.bar.*.demo.com'),
        ).toBe(false);
      });
    });

    describe('IPv6 Origins', () => {
      it('should handle IPv6 origins without treating colons as label separators', () => {
        // IPv6 addresses should be treated as single units, not parsed for subdomains
        const ipv6Origins = [
          'https://[2001:db8::1]',
          'http://[::1]',
          'https://[fe80::1234:5678]',
          'http://[2001:db8:85a3::8a2e:370:7334]',
          'https://[2001:db8::1]:8080',
        ];

        // IPv6 addresses should normalize correctly
        for (const origin of ipv6Origins) {
          const normalized = normalizeOrigin(origin);
          expect(normalized).toBe(origin);
          expect(typeof normalized).toBe('string');
          expect(normalized.includes('[')).toBe(true);
          expect(normalized.includes(']')).toBe(true);
        }

        // IPv6 addresses should not match domain wildcards
        expect(
          matchesWildcardOrigin('https://[2001:db8::1]', '*.example.com'),
        ).toBe(false);
        expect(matchesWildcardOrigin('http://[::1]', '**.example.com')).toBe(
          false,
        );

        // But should match protocol-only wildcards
        expect(
          matchesWildcardOrigin('https://[2001:db8::1]', 'https://*'),
        ).toBe(true);
        expect(matchesWildcardOrigin('http://[::1]', 'http://*')).toBe(true);
        expect(matchesWildcardOrigin('https://[2001:db8::1]', 'http://*')).toBe(
          false,
        );
      });

      it('should handle IPv6 with ports correctly', () => {
        // IPv6 with non-default ports
        expect(normalizeOrigin('https://[2001:db8::1]:8080')).toBe(
          'https://[2001:db8::1]:8080',
        );
        expect(normalizeOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');

        // IPv6 with default ports should be normalized
        expect(normalizeOrigin('https://[2001:db8::1]:443')).toBe(
          'https://[2001:db8::1]',
        );
        expect(normalizeOrigin('http://[::1]:80')).toBe('http://[::1]');
      });

      it('should handle IPv6 in origin lists', () => {
        const origins = ['https://[2001:db8::1]', 'http://[::1]:3000'];

        expect(matchesOriginList('https://[2001:db8::1]', origins)).toBe(true);
        expect(matchesOriginList('http://[::1]:3000', origins)).toBe(true);
        expect(matchesOriginList('https://[::1]', origins)).toBe(false);

        // Should work with port normalization
        expect(matchesOriginList('https://[2001:db8::1]:443', origins)).toBe(
          true,
        );
      });

      it('should match exact origin lists across equivalent IPv6 spellings', () => {
        expect(
          matchesOriginList('https://[2001:db8::1]', [
            'https://[2001:0db8:0:0:0:0:0:1]',
          ]),
        ).toBe(true);
        expect(
          matchesOriginList('http://[::1]', ['http://[0:0:0:0:0:0:0:1]']),
        ).toBe(true);
      });
    });

    describe('Null Origin Flow', () => {
      it("should handle 'null' origin normalization", () => {
        // normalizeOrigin should return "null" for string "null"
        expect(normalizeOrigin('null')).toBe('null');
        expect(normalizeOrigin('NULL')).toBe(''); // Case sensitive enforced

        // Other invalid URLs return empty sentinel
        expect(normalizeOrigin('invalid-url')).toBe('');
        expect(normalizeOrigin('')).toBe('');
        expect(normalizeOrigin('not-a-url')).toBe('');
      });

      it("should ensure wildcard patterns do not match 'null' origins", () => {
        // Wildcard domain matching should not match "null"
        expect(matchesWildcardDomain('null', '*.example.com')).toBe(false);
        expect(matchesWildcardDomain('null', '**.example.com')).toBe(false);
        expect(matchesWildcardDomain('null', '*.*.example.com')).toBe(false);

        // Wildcard origin matching should not match "null"
        expect(matchesWildcardOrigin('null', '*.example.com')).toBe(false);
        expect(matchesWildcardOrigin('null', '**.example.com')).toBe(false);
        expect(matchesWildcardOrigin('null', 'https://*')).toBe(false);
        expect(matchesWildcardOrigin('null', 'http://*.example.com')).toBe(
          false,
        );
      });

      it("should allow exact 'null' matches in origin lists", () => {
        // Exact string matching should work for "null"
        expect(matchesOriginList('null', ['null', 'https://example.com'])).toBe(
          true,
        );
        expect(matchesOriginList('null', ['https://example.com'])).toBe(false);

        // CORS credentials should work with exact "null" matches
        expect(matchesCORSCredentialsList('null', ['null'])).toBe(true);
        expect(
          matchesCORSCredentialsList('null', ['https://example.com']),
        ).toBe(false);

        // Wildcard credentials should not match "null" even if "null" is in pattern
        expect(
          matchesCORSCredentialsList('null', ['*.example.com'], {
            allowWildcardSubdomains: true,
          }),
        ).toBe(false);
        expect(
          matchesCORSCredentialsList('null', ['null', '*.example.com'], {
            allowWildcardSubdomains: true,
          }),
        ).toBe(true); // exact match
      });

      it("should reject 'null' in domain lists", () => {
        // Domain matching should not work with "null" for wildcards
        expect(matchesDomainList('null', ['*.example.com'])).toBe(false);
        expect(matchesDomainList('null', ['**.example.com'])).toBe(false);

        // Exact domain matching should also reject "null"; it is origin-only.
        expect(matchesDomainList('null', ['null', 'example.com'])).toBe(false);
        expect(matchesDomainList('null', ['example.com'])).toBe(false);
      });

      it('rejects exact domains that equal a public suffix', () => {
        const r = validateConfigEntry('com', 'domain');
        expect(r.valid).toBe(false);
        expect(r.info).toBe('entry equals a public suffix (not registrable)');
      });

      it('rejects protocol wildcards in domain context with clear message', () => {
        const r = validateConfigEntry('https://*', 'domain');
        expect(r.valid).toBe(false);
        expect(r.info).toBe('protocols are not allowed in domain context');
      });

      it('rejects origin-style entries in domain context with clear message', () => {
        const r = validateConfigEntry('https://example.com', 'domain');
        expect(r.valid).toBe(false);
        expect(r.info).toBe('protocols are not allowed in domain context');
      });

      it('allows exact IP addresses in domain context', () => {
        const r = validateConfigEntry('127.0.0.1', 'domain');
        expect(r.valid).toBe(true);
      });

      it('rejects exact domains with invalid characters', () => {
        // @ character should be rejected
        expect(validateConfigEntry('example.com@evil', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        // Brackets should be rejected (unless valid IPv6)
        expect(validateConfigEntry('exa[mple].com', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        // Backslash should be rejected
        expect(validateConfigEntry('exa\\mple.com', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        // Other invalid characters
        expect(validateConfigEntry('example.com/path', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('example.com?query', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('example.com#fragment', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('example.com:8080', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });
      });
    });

    describe('validateConfigEntry', () => {
      it('should reject empty entries', () => {
        expect(validateConfigEntry('', 'origin')).toEqual({
          valid: false,
          info: 'empty entry',
          wildcardKind: 'none',
        });
      });

      it("should validate global wildcard '*' in origin context when allowed", () => {
        // Global wildcard should be valid when explicitly allowed
        expect(
          validateConfigEntry('*', 'origin', { allowGlobalWildcard: true }),
        ).toEqual({
          valid: true,
          wildcardKind: 'global',
        });

        // Should be invalid by default
        expect(validateConfigEntry('*', 'origin')).toEqual({
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        });

        expect(
          validateConfigEntry('*', 'origin', { allowGlobalWildcard: false }),
        ).toEqual({
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        });
      });

      it("should reject global wildcard '*' in domain context", () => {
        // Global wildcard should be rejected by default in domain context
        expect(validateConfigEntry('*', 'domain')).toEqual({
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        });

        expect(
          validateConfigEntry('*', 'domain', { allowGlobalWildcard: true }),
        ).toEqual({
          valid: true,
          wildcardKind: 'global',
        });
      });

      it('should reject invalid all-wildcard patterns', () => {
        // These should be rejected in both contexts
        expect(validateConfigEntry('*.*', 'origin')).toEqual({
          valid: false,
          info: 'all-wildcards pattern is not allowed',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('**.*', 'origin')).toEqual({
          valid: false,
          info: 'all-wildcards pattern is not allowed',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('*.*.com', 'origin')).toEqual({
          valid: false,
          info: 'wildcard tail targets public suffix or IP (disallowed)',
          wildcardKind: 'none',
        });
      });

      it('should reject userinfo in origin entries', () => {
        expect(
          validateConfigEntry('https://user:pass@example.com', 'origin'),
        ).toEqual({
          valid: false,
          info: 'origin must not include userinfo',
          wildcardKind: 'none',
        });

        expect(
          validateConfigEntry('http://admin@api.example.com', 'origin'),
        ).toEqual({
          valid: false,
          info: 'origin must not include userinfo',
          wildcardKind: 'none',
        });

        expect(
          validateConfigEntry('https://user@localhost:3000', 'origin'),
        ).toEqual({
          valid: false,
          info: 'origin must not include userinfo',
          wildcardKind: 'none',
        });
      });

      it('should require valid URL parsing for protocol-only wildcards', () => {
        // Valid URLs should match protocol wildcards
        expect(matchesWildcardOrigin('https://example.com', 'https://*')).toBe(
          true,
        );
        expect(matchesWildcardOrigin('http://example.com', 'http://*')).toBe(
          true,
        );

        // Invalid URLs should NOT match protocol wildcards (security improvement)
        expect(matchesWildcardOrigin('https://', 'https://*')).toBe(false);
        expect(matchesWildcardOrigin('https:// bad', 'https://*')).toBe(false);
        expect(matchesWildcardOrigin('not-a-url', 'https://*')).toBe(false);
        expect(matchesWildcardOrigin('https://-bad.com', 'https://*')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://example..com', 'https://*')).toBe(
          false,
        );

        // URLs that parse but have invalid hostnames should still be rejected by domain normalization
        expect(
          matchesWildcardOrigin(
            'https://invalid..domain',
            'https://*.example.com',
          ),
        ).toBe(false);

        // Wrong protocol should not match
        expect(matchesWildcardOrigin('http://example.com', 'https://*')).toBe(
          false,
        );
        expect(matchesWildcardOrigin('https://example.com', 'http://*')).toBe(
          false,
        );
      });

      it('should reject full URLs with path, query, or fragment in wildcard matching', () => {
        expect(
          matchesWildcardOrigin(
            'https://api.example.com/path?x=1',
            '*.example.com',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com/path?x=1',
            'https://*.example.com',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin(
            'https://api.example.com/path?x=1',
            'https://*',
          ),
        ).toBe(false);
        expect(
          matchesWildcardOrigin('https://api.example.com/path?x=1', '*'),
        ).toBe(false);
      });

      it('should fast-fail on invalid wildcard patterns', () => {
        // Invalid patterns with non-domain characters should fail quickly
        expect(matchesWildcardDomain('example.com', '*.example.com:8080')).toBe(
          false,
        );
        expect(matchesWildcardDomain('example.com', '*.example.com/path')).toBe(
          false,
        );
        expect(
          matchesWildcardDomain('example.com', '*.example.com?query'),
        ).toBe(false);
        expect(
          matchesWildcardDomain('example.com', '*.example.com#fragment'),
        ).toBe(false);

        // Invalid patterns with oversized labels should fail quickly
        const longLabel = 'a'.repeat(64); // > 63 chars
        expect(matchesWildcardDomain('example.com', `*.${longLabel}.com`)).toBe(
          false,
        );

        // Invalid patterns with empty labels should fail quickly
        expect(matchesWildcardDomain('example.com', '*.example..com')).toBe(
          false,
        );
      });

      it('should normalize Unicode dot variants in wildcard patterns', () => {
        // Unicode dot variants should be normalized to ASCII dots for security
        expect(matchesWildcardDomain('api.example.com', '*．example.com')).toBe(
          true,
        ); // Full-width dot (U+FF0E)
        expect(matchesWildcardDomain('api.example.com', '*。example.com')).toBe(
          true,
        ); // Ideographic full stop (U+3002)
        expect(matchesWildcardDomain('api.example.com', '*｡example.com')).toBe(
          true,
        ); // Halfwidth ideographic period (U+FF61)

        // Mixed Unicode and ASCII dots should work
        expect(
          matchesWildcardDomain('api.sub.example.com', '*．*.example.com'),
        ).toBe(true);
        expect(
          matchesWildcardDomain('api.sub.example.com', '*.sub。example.com'),
        ).toBe(true);

        // Should also work in validateConfigEntry
        const result = validateConfigEntry('*．example.com', 'domain');
        expect(result.valid).toBe(true);
        expect(result.wildcardKind).toBe('subdomain');
      });

      it('should normalize Unicode dot variants in regular domains', () => {
        // Unicode dots in domain names should be normalized to prevent bypasses
        expect(normalizeDomain('api．example.com')).toBe('api.example.com');
        expect(normalizeDomain('api。example.com')).toBe('api.example.com');
        expect(normalizeDomain('api｡example.com')).toBe('api.example.com');

        // Mixed Unicode and ASCII dots
        expect(normalizeDomain('api．sub.example。com')).toBe(
          'api.sub.example.com',
        );
      });

      it('should recognize Unicode dot IPv4 addresses consistently', () => {
        // Unicode dots in IPv4 addresses should be normalized and recognized as IPs
        expect(normalizeDomain('127。0。0。1')).toBe('127.0.0.1');
        expect(normalizeDomain('192．168．1．1')).toBe('192.168.1.1');
        expect(normalizeDomain('10｡0｡0｡1')).toBe('10.0.0.1');

        // Mixed Unicode and ASCII dots in IPs
        expect(normalizeDomain('127.0。0.1')).toBe('127.0.0.1');

        // Should also work in validation
        expect(validateConfigEntry('127。0。0。1', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('192．168．1．1', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });

        // Should work in origin normalization (Chrome compatibility)
        expect(normalizeOrigin('https://127。0。0。1')).toBe(
          'https://127.0.0.1',
        );
        expect(normalizeOrigin('http://192．168．1．1:8080')).toBe(
          'http://192.168.1.1:8080',
        );

        // Should work in wildcard origin matching
        expect(matchesWildcardOrigin('https://127。0。0。1', 'https://*')).toBe(
          true,
        );
        expect(
          matchesWildcardOrigin(
            'http://api．example。com',
            'http://*.example.com',
          ),
        ).toBe(true);
        expect(
          matchesWildcardOrigin(
            'https://subdomain．example。com',
            'https://*.example.com',
          ),
        ).toBe(true);
      });

      it('should fix matchesOriginList global wildcard to properly validate origins', () => {
        // Global wildcard should delegate to matchesWildcardOrigin for proper validation
        expect(matchesOriginList('https://example.com', ['*'])).toBe(true);
        expect(matchesOriginList('http://example.com', ['*'])).toBe(true);

        // Should reject invalid origins that don't parse as valid HTTP(S) URLs
        expect(matchesOriginList('null', ['*'])).toBe(false);
        expect(matchesOriginList('ftp://example.com', ['*'])).toBe(false);
        expect(matchesOriginList('not-a-url', ['*'])).toBe(false);
        expect(matchesOriginList('https://', ['*'])).toBe(false);
      });

      it('should allow global wildcard in domain context when explicitly enabled', () => {
        // Global wildcard should be allowed in domain context when allowGlobalWildcard is true
        expect(
          validateConfigEntry('*', 'domain', { allowGlobalWildcard: true }),
        ).toEqual({
          valid: true,
          wildcardKind: 'global',
        });

        // Should be rejected when allowGlobalWildcard is false (default)
        expect(
          validateConfigEntry('*', 'domain', { allowGlobalWildcard: false }),
        ).toEqual({
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        });

        // Default behavior should reject it
        expect(validateConfigEntry('*', 'domain')).toEqual({
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        });
      });

      it('should allow IP addresses in domain context consistently', () => {
        // IPv4 addresses should be allowed
        expect(validateConfigEntry('127.0.0.1', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('192.168.1.1', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });

        // IPv6 addresses should be allowed (both with and without brackets)
        expect(validateConfigEntry('2001:db8::1', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('[2001:db8::1]', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('fe80::1%eth0', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('[fe80::1%25eth0]', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain',
          wildcardKind: 'none',
        });

        // Invalid IP-like strings are treated as domain names (not IPs), so they may be valid domains
        // This is consistent with how browsers and DNS work - "999.999.999.999" could theoretically be a domain name
        expect(validateConfigEntry('999.999.999.999', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
      });

      it('should detect wildcard types correctly', () => {
        // Global wildcard
        const global = validateConfigEntry('*', 'origin', {
          allowGlobalWildcard: true,
        });
        expect(global.valid).toBe(true);
        expect(global.wildcardKind).toBe('global');

        // Protocol wildcard
        const protocol = validateConfigEntry('https://*', 'origin');
        expect(protocol.valid).toBe(true);
        expect(protocol.wildcardKind).toBe('protocol');

        // Subdomain wildcard
        const subdomain = validateConfigEntry('*.example.com', 'origin');
        expect(subdomain.valid).toBe(true);
        expect(subdomain.wildcardKind).toBe('subdomain');

        // Double asterisk subdomain wildcard
        const doubleSubdomain = validateConfigEntry('**.example.com', 'domain');
        expect(doubleSubdomain.valid).toBe(true);
        expect(doubleSubdomain.wildcardKind).toBe('subdomain');

        // Protocol + subdomain wildcard
        const protocolSubdomain = validateConfigEntry(
          'https://*.example.com',
          'origin',
        );
        expect(protocolSubdomain.valid).toBe(true);
        expect(protocolSubdomain.wildcardKind).toBe('subdomain');

        // Exact domain (no wildcard)
        const exact = validateConfigEntry('example.com', 'domain');
        expect(exact.valid).toBe(true);
        expect(exact.wildcardKind).toBe('none');

        // Exact origin (no wildcard)
        const exactOrigin = validateConfigEntry(
          'https://example.com',
          'origin',
        );
        expect(exactOrigin.valid).toBe(true);
        expect(exactOrigin.wildcardKind).toBe('none');
      });

      it('accepts a single trailing dot on exact and wildcard entries consistently', () => {
        expect(validateConfigEntry('example.com.', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('*.example.com.', 'domain')).toEqual({
          valid: true,
          wildcardKind: 'subdomain',
        });
        expect(validateConfigEntry('https://example.com.', 'origin')).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
        expect(validateConfigEntry('https://*.example.com.', 'origin')).toEqual(
          {
            valid: true,
            wildcardKind: 'subdomain',
          },
        );
      });

      it("optionally allows global '*' when enabled", () => {
        const disallowed = validateConfigEntry('*', 'origin');
        expect(disallowed.valid).toBe(false);
        expect(disallowed.info).toMatch(/global wildcard '\*' not allowed/i);

        const allowed = validateConfigEntry('*', 'origin', {
          allowGlobalWildcard: true,
        });
        expect(allowed.valid).toBe(true);
      });

      it("still rejects all-wildcard domain patterns like '*.*'", () => {
        const r = validateConfigEntry('*.*', 'origin', {
          allowGlobalWildcard: true,
        });
        expect(r.valid).toBe(false);
      });

      it('can disable protocol-only wildcard via option', () => {
        const def = validateConfigEntry('https://*', 'origin');
        expect(def.valid).toBe(true); // default allows protocol wildcard

        const off = validateConfigEntry('https://*', 'origin', {
          allowProtocolWildcard: false,
        });
        expect(off.valid).toBe(false);
        expect(off.info).toMatch(/protocol wildcard not allowed/i);
      });
      it("allows literal 'null' origin", () => {
        const r = validateConfigEntry('null', 'origin');
        expect(r.valid).toBe(true);
        expect(r.info).toBeUndefined();
      });

      it("rejects literal 'null' in domain context", () => {
        const r = validateConfigEntry('null', 'domain');
        expect(r.valid).toBe(false);
      });

      it('rejects mixed-case null origins that would never match at runtime', () => {
        const upper = validateConfigEntry('NULL', 'origin');
        expect(upper.valid).toBe(false);
        expect(matchesOriginList('null', ['NULL'])).toBe(false);
        expect(matchesCORSCredentialsList('null', ['NULL'])).toBe(false);

        const mixed = validateConfigEntry('Null', 'origin');
        expect(mixed.valid).toBe(false);
        expect(matchesOriginList('null', ['Null'])).toBe(false);
        expect(matchesCORSCredentialsList('null', ['Null'])).toBe(false);
      });

      it('rejects missing host and disallows path/query/fragment beyond a single trailing slash', () => {
        const r1 = validateConfigEntry('https://', 'origin');
        expect(r1.valid).toBe(false);
        expect(r1.info).toBe('missing host in origin');

        const rSlash = validateConfigEntry('https://example.com/', 'origin');
        expect(rSlash).toEqual({
          valid: true,
          wildcardKind: 'none',
        });

        const rDoubleSlash = validateConfigEntry(
          'https://example.com//',
          'origin',
        );
        expect(rDoubleSlash.valid).toBe(false);
        expect(rDoubleSlash.info).toBe(
          'origin must not contain path, query, or fragment',
        );

        const r2 = validateConfigEntry('https://example.com/path', 'origin');
        expect(r2.valid).toBe(false);
        expect(r2.info).toBe(
          'origin must not contain path, query, or fragment',
        );

        const rWildcardSlash = validateConfigEntry(
          'https://*.example.com/',
          'origin',
        );
        expect(rWildcardSlash.valid).toBe(false);
        expect(rWildcardSlash.info).toBe(
          'origin must not contain path, query, or fragment',
        );
      });

      it('rejects malformed schemes in exact origins', () => {
        const badLeading = validateConfigEntry('1http://example.com', 'origin');
        expect(badLeading.valid).toBe(false);
        expect(badLeading.info).toBe('invalid scheme in origin');

        const missingName = validateConfigEntry('://example.com', 'origin');
        expect(missingName.valid).toBe(false);
        expect(missingName.info).toBe('invalid scheme in origin');

        const spaced = validateConfigEntry('ht tp://example.com', 'origin');
        expect(spaced.valid).toBe(false);
        expect(spaced.info).toBe('invalid scheme in origin');
      });

      it('covers additional exact-domain and wildcard validation branches', () => {
        expect(validateConfigEntry('a..b', 'domain')).toEqual({
          valid: false,
          info: 'invalid domain',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('foo.**', 'domain')).toEqual({
          valid: false,
          info: 'wildcard tail targets public suffix or IP (disallowed)',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry('*.example.com:443', 'domain')).toEqual({
          valid: false,
          info: 'invalid characters in domain pattern',
          wildcardKind: 'none',
        });

        const label64 = 'a'.repeat(64);
        expect(
          validateConfigEntry(`*.${label64}.example.com`, 'domain'),
        ).toEqual({
          valid: false,
          info: 'invalid domain labels',
          wildcardKind: 'none',
        });

        const concreteTooLong = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.*.example.com`;
        expect(validateConfigEntry(concreteTooLong, 'domain')).toEqual({
          valid: false,
          info: 'invalid domain labels',
          wildcardKind: 'none',
        });
      });

      it('rejects wildcard patterns that exceed the runtime label cap', () => {
        const oversized = `${new Array(33).fill('*').join('.')}.example.com`;

        expect(validateConfigEntry(oversized, 'domain')).toEqual({
          valid: false,
          info: 'wildcard pattern exceeds label limit',
          wildcardKind: 'none',
        });

        expect(validateConfigEntry(`https://${oversized}`, 'origin')).toEqual({
          valid: false,
          info: 'wildcard pattern exceeds label limit',
          wildcardKind: 'none',
        });
      });

      it('rejects invalid ports in exact origins', () => {
        const alphaPort = validateConfigEntry(
          'https://example.com:abc',
          'origin',
        );
        expect(alphaPort.valid).toBe(false);
        expect(alphaPort.info).toBe('invalid port in origin');

        const emptyPort = validateConfigEntry('https://example.com:', 'origin');
        expect(emptyPort.valid).toBe(false);
        expect(emptyPort.info).toBe('invalid port in origin');

        const ipv6AlphaPort = validateConfigEntry(
          'https://[::1]:abc',
          'origin',
        );
        expect(ipv6AlphaPort.valid).toBe(false);
        expect(ipv6AlphaPort.info).toBe('invalid port in origin');

        const tooLargePort = validateConfigEntry(
          'https://example.com:65536',
          'origin',
        );
        expect(tooLargePort.valid).toBe(false);
        expect(tooLargePort.info).toBe('invalid port in origin');

        const ipv6TooLargePort = validateConfigEntry(
          'https://[::1]:99999',
          'origin',
        );
        expect(ipv6TooLargePort.valid).toBe(false);
        expect(ipv6TooLargePort.info).toBe('invalid port in origin');

        const maxPort = validateConfigEntry(
          'https://example.com:65535',
          'origin',
        );
        expect(maxPort.valid).toBe(true);
      });

      it('supports protocol-only wildcards with scheme info', () => {
        const httpsAny = validateConfigEntry('https://*', 'origin');
        expect(httpsAny.valid).toBe(true);
        expect(httpsAny.info).toBeUndefined();

        const wsAny = validateConfigEntry('ws://*', 'origin');
        expect(wsAny.valid).toBe(false);
        expect(wsAny.info).toBe(
          'wildcard origins require http or https scheme',
        );
      });

      it('rejects ports and IP-literals in wildcard origins', () => {
        const withPort = validateConfigEntry(
          'https://*.example.com:443',
          'origin',
        );
        expect(withPort.valid).toBe(false);
        expect(withPort.info).toBe('ports are not allowed in wildcard origins');

        const ipLit = validateConfigEntry('https://[*]', 'origin');
        expect(ipLit.valid).toBe(false);
        expect(ipLit.info).toBe('wildcard host cannot be an IP literal');
      });

      it('rejects invalid wildcard host patterns in origin', () => {
        const partial = validateConfigEntry(
          'https://ex*.example.com',
          'origin',
        );
        expect(partial.valid).toBe(false);
        expect(partial.info).toBe('partial-label wildcards are not allowed');

        const psl = validateConfigEntry('https://*.com', 'origin');
        expect(psl.valid).toBe(false);
        expect(psl.info).toBe(
          'wildcard tail targets public suffix or IP (disallowed)',
        );
      });

      it('rejects partial-label wildcards in domain and origin contexts', () => {
        // Domain context
        const dom = validateConfigEntry('ex*.demo.com', 'domain');
        expect(dom.valid).toBe(false);
        expect(dom.info).toMatch(/partial-label wildcards/i);

        // matches helpers should also reject by treating pattern as invalid
        expect(matchesWildcardDomain('foo.demo.com', 'ex*.demo.com')).toBe(
          false,
        );

        // Origin context (protocol-agnostic host pattern)
        const org = validateConfigEntry('ex*.demo.com', 'origin');
        expect(org.valid).toBe(false);
        expect(org.info).toMatch(/partial-label wildcards/i);

        expect(
          matchesWildcardOrigin('https://foo.demo.com', 'ex*.demo.com'),
        ).toBe(false);
      });

      it('accepts exact IPv6 and IP literal origins (with scheme info when non-http)', () => {
        const v6 = validateConfigEntry('https://[2001:db8::1]', 'origin');
        expect(v6.valid).toBe(true);
        expect(v6.info).toBeUndefined();

        const v6Port = validateConfigEntry('https://[::1]:443', 'origin');
        expect(v6Port.valid).toBe(true);

        const ip = validateConfigEntry('ftp://127.0.0.1:21', 'origin');
        expect(ip.valid).toBe(true);
        expect(ip.info).toBe('non-http(s) scheme; CORS may not match');
      });

      it('rejects malformed bracketed IPv6 literals in exact origins', () => {
        const badText = validateConfigEntry('https://[not-an-ip]', 'origin');
        expect(badText.valid).toBe(false);
        expect(badText.info).toBe('invalid IPv6 literal in origin');

        const empty = validateConfigEntry('https://[]', 'origin');
        expect(empty.valid).toBe(false);
        expect(empty.info).toBe('invalid IPv6 literal in origin');
      });

      it('validates bracketed IPv6 structure in origins', () => {
        const unclosed = validateConfigEntry('https://[2001:db8::1', 'origin');
        expect(unclosed.valid).toBe(false);
        expect(unclosed.info).toBe('unclosed IPv6 bracket');

        const extra = validateConfigEntry('https://[::1]abc', 'origin');
        expect(extra.valid).toBe(false);
        expect(extra.info).toBe('unexpected characters after IPv6 host');
      });

      it('rejects exact origins where host equals a public suffix or has invalid domain', () => {
        const psl = validateConfigEntry('https://com', 'origin');
        expect(psl.valid).toBe(false);
        expect(psl.info).toBe(
          'origin host equals a public suffix (not registrable)',
        );

        const bad = validateConfigEntry('https://a..b', 'origin');
        expect(bad.valid).toBe(false);
        expect(bad.info).toBe('invalid domain in origin');
      });

      it('rejects wildcard patterns with concrete labels that fail IDN normalization', () => {
        // Underscore is rejected by TR46 useSTD3ASCIIRules — normalizeDomain returns ''
        // This exercises the nd === '' branch in validateConcreteLabels
        const underscoreLabel = validateConfigEntry(
          '*.foo_bar.example.com',
          'domain',
        );
        expect(underscoreLabel.valid).toBe(false);
        expect(underscoreLabel.info).toBe('invalid domain labels');

        // Same check in origin context
        const underscoreOrigin = validateConfigEntry(
          '*.foo_bar.example.com',
          'origin',
        );
        expect(underscoreOrigin.valid).toBe(false);
        expect(underscoreOrigin.info).toBe('invalid domain labels');
      });

      it('applies domain rules to bare domains in origin context', () => {
        const ok = validateConfigEntry('*.localhost', 'origin');
        expect(ok.valid).toBe(false);
        expect(ok.info).toBe(
          'wildcard tail targets public suffix or IP (disallowed)',
        );

        const bad = validateConfigEntry('*.127.0.0.1', 'origin');
        expect(bad.valid).toBe(false);
        expect(bad.info).toBe(
          'wildcard tail targets public suffix or IP (disallowed)',
        );

        const badWildcardScheme = validateConfigEntry(
          'ws://*.example.com',
          'origin',
        );
        expect(badWildcardScheme.valid).toBe(false);
        expect(badWildcardScheme.info).toBe(
          'wildcard origins require http or https scheme',
        );

        const bareWildcard = validateConfigEntry('*.example.com', 'origin');
        expect(bareWildcard).toEqual({
          valid: true,
          wildcardKind: 'subdomain',
        });

        const bareExact = validateConfigEntry('example.com', 'origin');
        expect(bareExact).toEqual({
          valid: true,
          wildcardKind: 'none',
        });
      });
    });
  });

  describe('matchesOriginList - malformed entries', () => {
    it('silently skips entries with trailing colon (no port value)', () => {
      // "https://example.com:" is malformed — hostPort ends with ":" with no port digit
      expect(
        matchesOriginList('https://example.com', ['https://example.com:']),
      ).toBe(false);
      expect(
        matchesOriginList('https://example.com', [
          'https://example.com:',
          'https://example.com',
        ]),
      ).toBe(true); // valid entry still matches
    });

    it('rejects an origin whose hostname fails normalization (normalizeOrigin returns empty)', () => {
      // An exact-origin list entry with an underscore in the hostname parses as a URL
      // but fails TR46 normalization — normalizeOrigin returns '', so parseExactOriginForMatching returns null
      expect(
        matchesOriginList('https://example.com', [
          'https://foo_bar.example.com',
        ]),
      ).toBe(false);
    });
  });

  describe('matchesCORSCredentialsList - credential-safe wildcard edge cases', () => {
    it('rejects patterns with no wildcard even when allowWildcardSubdomains is true', () => {
      // isValidCredentialWildcardHost returns false for non-wildcard patterns
      expect(
        matchesCORSCredentialsList('https://example.com', ['example.com'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(true); // still works via exact domain path, not wildcard path
    });

    it('rejects wildcard patterns with invalid domain characters', () => {
      expect(
        matchesCORSCredentialsList(
          'https://api.example.com',
          ['*.example.com:443'], // colon is invalid in a wildcard host
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects partial-label wildcard patterns', () => {
      expect(
        matchesCORSCredentialsList(
          'https://api.example.com',
          ['api*.example.com'],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects wildcard patterns with concrete labels that fail IDN normalization', () => {
      // Underscore label fails TR46 — nd === '' branch inside isValidCredentialWildcardHost
      expect(
        matchesCORSCredentialsList(
          'https://app.example.com',
          ['*.foo_bar.example.com'],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects wildcard patterns with a concrete label over 63 chars', () => {
      const longLabel = 'a'.repeat(64);
      expect(
        matchesCORSCredentialsList(
          'https://app.example.com',
          [`*.${longLabel}.example.com`],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects wildcard patterns whose combined concrete labels exceed 255 bytes', () => {
      // 5 × 63-char labels = 319 chars total — checkDNSLength fails
      const seg = 'a'.repeat(63);
      expect(
        matchesCORSCredentialsList(
          'https://app.example.com',
          [`*.${seg}.${seg}.${seg}.${seg}.${seg}`],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects wildcard tail targeting a public suffix', () => {
      expect(
        matchesCORSCredentialsList('https://api.example.com', ['*.com'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });

    it('rejects *.localhost like other suffix-wide wildcards', () => {
      expect(
        matchesCORSCredentialsList('https://app.localhost', ['*.localhost'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });

    it('rejects wildcard pattern where all concrete labels come before the wildcard (no fixed tail)', () => {
      // example.com.* — wildcard is the rightmost label, fixed tail is empty
      expect(
        matchesCORSCredentialsList(
          'https://app.example.com',
          ['example.com.*'],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects wildcard tail targeting an IP address', () => {
      // *.192.168.0.1 — tail is an IP, which is disallowed
      expect(
        matchesCORSCredentialsList(
          'https://app.example.com',
          ['*.192.168.0.1'],
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);
    });

    it('rejects https://* (protocol-only wildcard) in credentials mode', () => {
      expect(
        matchesCORSCredentialsList('https://example.com', ['https://*'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });
  });

  describe('matchesCORSCredentialsList (legacy patterns via option)', () => {
    it("should not broaden '*' into credentialed access when wildcard subdomains are enabled", () => {
      const allowedOrigins = ['*'];

      expect(
        matchesCORSCredentialsList('https://example.com', allowedOrigins, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('http://api.example.com', allowedOrigins, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList(
          'https://sub.domain.example.com',
          allowedOrigins,
          { allowWildcardSubdomains: true },
        ),
      ).toBe(false);

      // Should reject undefined/null origins
      expect(
        matchesCORSCredentialsList(undefined, allowedOrigins, {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });

    it('should reject invalid all-wildcard patterns for credentials', () => {
      // These should not match due to invalid patterns
      expect(
        matchesCORSCredentialsList('https://example.com', ['*.*'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
      expect(
        matchesCORSCredentialsList('https://example.com', ['**.*'], {
          allowWildcardSubdomains: true,
        }),
      ).toBe(false);
    });
  });
  describe('Limits and guards', () => {
    it('caps label counts via MAX_LABELS for domains and patterns', () => {
      const manyLabelsDomain =
        Array.from({ length: 38 }, (_, i) => `l${i}`).join('.') +
        '.example.com';
      // Domain has > MAX_LABELS labels (38 + 2)
      expect(matchesWildcardDomain(manyLabelsDomain, '**.example.com')).toBe(
        false,
      );

      const manyLabelsPattern =
        Array.from({ length: 33 }, () => '*').join('.') + '.example.com';
      expect(matchesWildcardDomain('api.example.com', manyLabelsPattern)).toBe(
        false,
      );
    });

    it('enforces step limit to avoid exponential blowups', () => {
      const deepDomain =
        Array.from({ length: 28 }, () => 'a').join('.') + '.example.com';
      const explosivePattern =
        Array.from({ length: 20 }, () => '**').join('.') + '.zzz.example.com';
      // Should fail without hanging due to step limit guard
      expect(matchesWildcardDomain(deepDomain, explosivePattern)).toBe(false);
    });

    it('covers helper-level DNS and wildcard guard branches', () => {
      const tooManyLabels = Array.from({ length: 128 }, () => 'a').join('.');
      expect(checkDNSLength(tooManyLabels)).toBe(false);
      expect(checkDNSLength('a..b')).toBe(false);
      // Trailing-dot (FQDN form): the trailing empty label is the last label → continue
      expect(checkDNSLength('example.com.')).toBe(true);

      expect(matchesWildcardLabels([], ['*'])).toBe(false);
      expect(matchesWildcardLabels(['a'], ['x', '**'])).toBe(false);

      expect(matchesMultiLabelPattern('example.com', '*.*')).toBe(false);
      expect(matchesMultiLabelPattern('example.com', 'example.com')).toBe(true);

      expect(normalizeWildcardPattern('*.example.com:443')).toBe('');
      expect(normalizeWildcardPattern('*.a..b')).toBe('');
    });

    it('halts at STEP_LIMIT for adversarially complex wildcard patterns', () => {
      // 25 'a' labels vs 15 '**'s + a required 'b' — no match exists (domain has no 'b'),
      // so every recursive branch fails. The combination space vastly exceeds STEP_LIMIT
      // (10,000), causing the guard to fire and return false rather than hanging.
      const manyDomainLabels = Array.from({ length: 25 }, () => 'a');
      const pattern = [...Array.from({ length: 15 }, () => '**'), 'b'];
      expect(matchesWildcardLabels(manyDomainLabels, pattern)).toBe(false);
    });

    it('covers interior ** matching (non-leftmost position)', () => {
      // Interior ** matches zero-or-more labels between fixed labels
      // Pattern ['a', '**', 'c'] against domain ['a', 'b', 'c'] — ** matches 'b'
      expect(matchesWildcardLabels(['a', 'b', 'c'], ['a', '**', 'c'])).toBe(
        true,
      );
      // ** matching zero labels: ['a', 'c'] against ['a', '**', 'c']
      expect(matchesWildcardLabels(['a', 'c'], ['a', '**', 'c'])).toBe(true);
      // ** matching multiple labels: ['a', 'x', 'y', 'c'] against ['a', '**', 'c']
      expect(
        matchesWildcardLabels(['a', 'x', 'y', 'c'], ['a', '**', 'c']),
      ).toBe(true);
      // Interior ** but wrong fixed label
      expect(matchesWildcardLabels(['a', 'b', 'z'], ['a', '**', 'c'])).toBe(
        false,
      );

      // Via matchesMultiLabelPattern with an interior ** pattern
      expect(matchesMultiLabelPattern('a.b.c', 'a.**.c')).toBe(true);
      expect(matchesMultiLabelPattern('a.c', 'a.**.c')).toBe(true);
      expect(matchesMultiLabelPattern('a.b.z', 'a.**.c')).toBe(false);
    });
  });

  describe('parseHostHeader', () => {
    it('should parse regular hostname without port', () => {
      expect(parseHostHeader('example.com')).toEqual({
        domain: 'example.com',
        port: '',
      });

      expect(parseHostHeader('api.example.com')).toEqual({
        domain: 'api.example.com',
        port: '',
      });

      expect(parseHostHeader('localhost')).toEqual({
        domain: 'localhost',
        port: '',
      });
    });

    it('should parse regular hostname with port', () => {
      expect(parseHostHeader('example.com:8080')).toEqual({
        domain: 'example.com',
        port: '8080',
      });

      expect(parseHostHeader('api.example.com:3000')).toEqual({
        domain: 'api.example.com',
        port: '3000',
      });

      expect(parseHostHeader('localhost:9876')).toEqual({
        domain: 'localhost',
        port: '9876',
      });
    });

    it('should parse IPv4 addresses without port', () => {
      expect(parseHostHeader('127.0.0.1')).toEqual({
        domain: '127.0.0.1',
        port: '',
      });

      expect(parseHostHeader('192.168.1.1')).toEqual({
        domain: '192.168.1.1',
        port: '',
      });
    });

    it('should parse IPv4 addresses with port', () => {
      expect(parseHostHeader('127.0.0.1:8080')).toEqual({
        domain: '127.0.0.1',
        port: '8080',
      });

      expect(parseHostHeader('192.168.1.1:3000')).toEqual({
        domain: '192.168.1.1',
        port: '3000',
      });
    });

    it('should parse IPv6 addresses with brackets (no port)', () => {
      expect(parseHostHeader('[::1]')).toEqual({
        domain: '::1',
        port: '',
      });

      expect(parseHostHeader('[2001:db8::1]')).toEqual({
        domain: '2001:db8::1',
        port: '',
      });

      expect(parseHostHeader('[fe80::1]')).toEqual({
        domain: 'fe80::1',
        port: '',
      });
    });

    it('should parse IPv6 addresses with brackets and port', () => {
      expect(parseHostHeader('[::1]:8080')).toEqual({
        domain: '::1',
        port: '8080',
      });

      expect(parseHostHeader('[2001:db8::1]:443')).toEqual({
        domain: '2001:db8::1',
        port: '443',
      });

      expect(parseHostHeader('[fe80::1]:3000')).toEqual({
        domain: 'fe80::1',
        port: '3000',
      });
    });

    it('should handle empty or whitespace input', () => {
      expect(parseHostHeader('')).toEqual({
        domain: '',
        port: '',
      });
      expect(parseHostHeader('   ')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should trim surrounding whitespace before parsing', () => {
      expect(parseHostHeader(' example.com:8080 ')).toEqual({
        domain: 'example.com',
        port: '8080',
      });

      expect(parseHostHeader(' [::1]:443 ')).toEqual({
        domain: '::1',
        port: '443',
      });

      expect(parseHostHeader(' localhost ')).toEqual({
        domain: 'localhost',
        port: '',
      });
    });

    it('should reject malformed IPv6 brackets', () => {
      // Missing closing bracket - return empty (malformed)
      expect(parseHostHeader('[::1')).toEqual({
        domain: '',
        port: '',
      });

      // Opening bracket but no valid structure
      expect(parseHostHeader('[malformed')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should reject junk after closing bracket (strict validation)', () => {
      // Double brackets - junk after first closing bracket
      expect(parseHostHeader('[::1][::2]')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('[abc][def]')).toEqual({
        domain: '',
        port: '',
      });

      // Nested brackets
      expect(parseHostHeader('[[::1]]')).toEqual({
        domain: '',
        port: '',
      });

      // Random junk after bracket
      expect(parseHostHeader('[::1]garbage')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('[::1] ')).toEqual({
        domain: '::1',
        port: '',
      });

      // Double brackets with port notation (still malformed)
      expect(parseHostHeader('[::1][::2]:8080')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should reject bracketed hosts that are not valid IPv6 literals', () => {
      expect(parseHostHeader('[abc]')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('[not-an-ip]:443')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should handle edge cases with colons', () => {
      // Port without hostname
      expect(parseHostHeader(':8080')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader(' :443 ')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should reject invalid port values as malformed', () => {
      expect(parseHostHeader('example.com:abc')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('example.com:')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('example.com:65536')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('[::1]:abc')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('[::1]:65536')).toEqual({
        domain: '',
        port: '',
      });

      expect(parseHostHeader('test:multiple:colons')).toEqual({
        domain: '',
        port: '',
      });
    });

    it('should strip brackets from IPv6 for normalization compatibility', () => {
      // The domain should have brackets stripped so it can be passed to normalizeDomain()
      const result = parseHostHeader('[::1]:8080');
      expect(result.domain).toBe('::1'); // Not '[::1]'
      expect(result.port).toBe('8080');

      // Verify this works with normalizeDomain
      const normalized = normalizeDomain(result.domain);
      expect(normalized).toBe('::1');
    });

    it('should handle real-world Host header examples', () => {
      // Standard web server examples
      expect(parseHostHeader('www.example.com')).toEqual({
        domain: 'www.example.com',
        port: '',
      });

      expect(parseHostHeader('example.com:443')).toEqual({
        domain: 'example.com',
        port: '443',
      });

      expect(parseHostHeader('localhost:3000')).toEqual({
        domain: 'localhost',
        port: '3000',
      });

      // IPv6 localhost
      expect(parseHostHeader('[::1]')).toEqual({
        domain: '::1',
        port: '',
      });

      expect(parseHostHeader('[::1]:8443')).toEqual({
        domain: '::1',
        port: '8443',
      });
    });
  });

  describe('isApexDomain', () => {
    it('should return true for apex domains', () => {
      expect(isApexDomain('example.com')).toBe(true);
      expect(isApexDomain('example.org')).toBe(true);
      expect(isApexDomain('example.net')).toBe(true);
    });

    it('should return true for apex domains with multi-part TLDs', () => {
      expect(isApexDomain('example.co.uk')).toBe(true);
      expect(isApexDomain('example.com.au')).toBe(true);
    });

    it('should return false for subdomains', () => {
      expect(isApexDomain('www.example.com')).toBe(false);
      expect(isApexDomain('api.example.com')).toBe(false);
      expect(isApexDomain('sub.example.co.uk')).toBe(false);
    });

    it('should return false for deeply nested subdomains', () => {
      expect(isApexDomain('deep.api.example.com')).toBe(false);
      expect(isApexDomain('a.b.c.example.com')).toBe(false);
    });

    it('should return false for IP addresses', () => {
      expect(isApexDomain('192.168.1.1')).toBe(false);
      expect(isApexDomain('127.0.0.1')).toBe(false);
      expect(isApexDomain('::1')).toBe(false);
    });

    it('should return true for internal pseudo-TLD apex domains', () => {
      expect(isApexDomain('localhost')).toBe(true);
      expect(isApexDomain('foo.local')).toBe(true);
      expect(isApexDomain('myapp.local')).toBe(true);
      expect(isApexDomain('myapp.test')).toBe(true);
      expect(isApexDomain('test')).toBe(true);
      expect(isApexDomain('api.internal')).toBe(true);
    });

    it('should return false for subdomains under pseudo-TLDs', () => {
      expect(isApexDomain('bar.foo.local')).toBe(false);
      expect(isApexDomain('sub.localhost')).toBe(false);
      expect(isApexDomain('sub.myapp.test')).toBe(false);
    });

    it('should return false for bare TLDs and empty input (no PSL match)', () => {
      expect(isApexDomain('com')).toBe(false);
      expect(isApexDomain('')).toBe(false);
    });

    it('should normalize case and a single trailing dot before apex checks', () => {
      expect(isApexDomain('Example.COM')).toBe(true);
      expect(isApexDomain('example.com.')).toBe(true);
      expect(isApexDomain('example.com..')).toBe(false);
    });
  });
});
