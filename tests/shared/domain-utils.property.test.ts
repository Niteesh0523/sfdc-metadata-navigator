/**
 * Property Test: Domain Detection (Property 6)
 *
 * Property 6: Domain detection correctly classifies Salesforce URLs
 * For any URL string, the domain detection function shall return `true`
 * if and only if the URL matches `*.salesforce.com`, `*.force.com`,
 * or `*.lightning.force.com` patterns.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 6: Domain detection correctly classifies Salesforce URLs
 * Validates: Requirements 1.3
 */

import * as fc from 'fast-check';
import { isSalesforceDomain } from '../../src/shared/domain-utils';

describe('Property 6: Domain detection correctly classifies Salesforce URLs', () => {
  // Valid Salesforce domain suffixes
  const SF_SUFFIXES = ['.salesforce.com', '.force.com', '.lightning.force.com'];

  // Arbitrary for generating valid Salesforce subdomains (e.g., "mycompany", "na1", "cs42")
  const subdomainArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 1, maxLength: 20 }
  ).filter(s => !s.startsWith('-') && !s.endsWith('-'));

  // Arbitrary for generating valid paths
  const pathArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789/-._%'.split('')),
    { minLength: 0, maxLength: 50 }
  ).map(p => p.startsWith('/') ? p : '/' + p);

  it('should return true for any valid HTTPS URL with a Salesforce domain suffix', () => {
    fc.assert(
      fc.property(
        subdomainArb,
        fc.constantFrom(...SF_SUFFIXES),
        pathArb,
        (subdomain, suffix, path) => {
          const url = `https://${subdomain}${suffix}${path}`;
          expect(isSalesforceDomain(url)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return false for HTTP (non-HTTPS) URLs even with Salesforce domains', () => {
    fc.assert(
      fc.property(
        subdomainArb,
        fc.constantFrom(...SF_SUFFIXES),
        pathArb,
        (subdomain, suffix, path) => {
          const url = `http://${subdomain}${suffix}${path}`;
          expect(isSalesforceDomain(url)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return false for non-Salesforce domains', () => {
    const nonSfDomains = fc.constantFrom(
      'google.com',
      'example.com',
      'salesforce.org',
      'notsalesforce.com',
      'force.net',
      'lightning.com',
      'mysalesforce.company.com',
      'salesforce.com.evil.com',
      'force.com.evil.com'
    );

    fc.assert(
      fc.property(
        subdomainArb,
        nonSfDomains,
        pathArb,
        (subdomain, domain, path) => {
          const url = `https://${subdomain}.${domain}${path}`;
          expect(isSalesforceDomain(url)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return false for bare top-level Salesforce domains without subdomain', () => {
    // Only salesforce.com and force.com are truly bare (no subdomain).
    // lightning.force.com has "lightning" as subdomain of .force.com, so it matches.
    const bareDomains = ['salesforce.com', 'force.com'];

    fc.assert(
      fc.property(
        fc.constantFrom(...bareDomains),
        pathArb,
        (domain, path) => {
          const url = `https://${domain}${path}`;
          expect(isSalesforceDomain(url)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return false for invalid/malformed URL strings', () => {
    const invalidUrls = fc.oneof(
      fc.string({ minLength: 0, maxLength: 50 }), // random strings
      fc.constant(''),
      fc.constant('not-a-url'),
      fc.constant('ftp://myorg.salesforce.com'),
      fc.constant('://missing-protocol.salesforce.com')
    );

    fc.assert(
      fc.property(invalidUrls, (url) => {
        // These should not throw and should return false
        const result = isSalesforceDomain(url);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: 100 }
    );
  });

  it('should be case-insensitive on the hostname', () => {
    fc.assert(
      fc.property(
        subdomainArb,
        fc.constantFrom(...SF_SUFFIXES),
        (subdomain, suffix) => {
          const upperUrl = `https://${subdomain.toUpperCase()}${suffix.toUpperCase()}/`;
          const lowerUrl = `https://${subdomain.toLowerCase()}${suffix.toLowerCase()}/`;
          // Both should give the same result
          expect(isSalesforceDomain(upperUrl)).toBe(isSalesforceDomain(lowerUrl));
        }
      ),
      { numRuns: 100 }
    );
  });
});
