/**
 * Property Test: Result Count Limit (Property 2)
 *
 * Property 2: Search results limited to maximum count
 * For any search query against any index of arbitrary size, the number of
 * displayed results shall never exceed the configured maximum (20 by default).
 *
 * Feature: sfdc-metadata-navigator-extension, Property 2: Search results limited to maximum count
 * Validates: Requirements 4.5
 */

import * as fc from 'fast-check';
import { IndexEntry, MetadataType } from '../../src/shared/types';
import { MetadataSearch } from '../../src/popup/search';
import { MAX_RESULTS } from '../../src/shared/constants';

describe('Property 2: Search results limited to maximum count', () => {
  const metadataTypes: MetadataType[] = [
    'Profile', 'PermissionSet', 'Flow', 'EmailTemplate',
    'Layout', 'ValidationRule', 'ApexClass',
  ];

  const typeLabels: Record<MetadataType, string> = {
    Profile: 'Profile',
    PermissionSet: 'Permission Set',
    Flow: 'Flow',
    EmailTemplate: 'Email Template',
    Layout: 'Page Layout',
    ValidationRule: 'Validation Rule',
    ApexClass: 'Apex Class',
  };

  // Generate entries with a common prefix to maximize matches
  const commonPrefixArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 2, maxLength: 5 }
  );

  // Generate a suffix to make each entry unique
  const suffixArb = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 1, maxLength: 15 }
  );

  const idArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 18, maxLength: 18 }
  );

  it('should never return more than MAX_RESULTS (20) items regardless of index size', () => {
    fc.assert(
      fc.property(
        commonPrefixArb,
        // Generate a large number of entries that all share the same prefix (to maximize matches)
        fc.integer({ min: 30, max: 100 }),
        fc.constantFrom(...metadataTypes),
        (prefix, count, type) => {
          // Build an index where all entries share the prefix (ensuring many matches)
          const entries: IndexEntry[] = [];
          for (let i = 0; i < count; i++) {
            entries.push({
              id: `00D${String(i).padStart(15, '0')}`,
              name: `${prefix}_item_${i}`,
              type,
              typeLabel: typeLabels[type],
              url: `/lightning/setup/Test/${i}`,
            });
          }

          const searcher = new MetadataSearch(entries);
          const results = searcher.search(prefix);

          // Result count must never exceed MAX_RESULTS
          expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should never return more than MAX_RESULTS even with single-character queries', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
        fc.integer({ min: 50, max: 150 }),
        (char, count) => {
          // Build entries all starting with the same character
          const entries: IndexEntry[] = [];
          for (let i = 0; i < count; i++) {
            entries.push({
              id: `00D${String(i).padStart(15, '0')}`,
              name: `${char}Entry_${i}_suffix`,
              type: 'ApexClass',
              typeLabel: 'Apex Class',
              url: `/lightning/setup/ApexClasses/${i}`,
            });
          }

          const searcher = new MetadataSearch(entries);
          const results = searcher.search(char);

          expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return results up to MAX_RESULTS when there are enough matches', () => {
    fc.assert(
      fc.property(
        commonPrefixArb,
        fc.integer({ min: 50, max: 100 }),
        (prefix, count) => {
          // All entries share the exact prefix, so they all match
          const entries: IndexEntry[] = [];
          for (let i = 0; i < count; i++) {
            entries.push({
              id: `00D${String(i).padStart(15, '0')}`,
              name: `${prefix}${i}`,
              type: 'Profile',
              typeLabel: 'Profile',
              url: `/lightning/setup/Profiles/${i}`,
            });
          }

          const searcher = new MetadataSearch(entries);
          const results = searcher.search(prefix);

          // Should have exactly MAX_RESULTS since count > MAX_RESULTS and all match
          // (or fewer if Fuse.js threshold excludes some)
          expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
          // But should have at least some results since all entries contain the prefix
          expect(results.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should cap results at MAX_RESULTS (20) which equals the constant value', () => {
    // Sanity check that MAX_RESULTS is 20
    expect(MAX_RESULTS).toBe(20);
  });
});
