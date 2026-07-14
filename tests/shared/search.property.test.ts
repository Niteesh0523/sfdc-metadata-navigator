/**
 * Property Test: Fuzzy Search Threshold (Property 1)
 *
 * Property 1: Fuzzy search returns relevant results within threshold
 * For any valid search query string and any search index, all items returned
 * by the fuzzy search function should have a match score at or above the
 * configured threshold, and no item with a score above the threshold should
 * be excluded from the results.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 1: Fuzzy search returns relevant results within threshold
 * Validates: Requirements 4.1, 4.2
 */

import * as fc from 'fast-check';
import Fuse from 'fuse.js';
import { IndexEntry, MetadataType } from '../../src/shared/types';
import { MetadataSearch } from '../../src/popup/search';

describe('Property 1: Fuzzy search returns relevant results within threshold', () => {
  const FUSE_THRESHOLD = 0.4; // Must match the threshold in search.ts

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

  // Arbitrary for generating realistic metadata names
  const metadataNameArb = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ -'.split('')),
    { minLength: 2, maxLength: 40 }
  ).filter(s => s.trim().length > 0);

  // Arbitrary for generating IndexEntry
  const indexEntryArb = fc.tuple(
    metadataNameArb,
    fc.constantFrom(...metadataTypes),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 18, maxLength: 18 })
  ).map(([name, type, id]): IndexEntry => ({
    id,
    name,
    type,
    typeLabel: typeLabels[type],
    url: `/lightning/setup/Test/${id}`,
  }));

  // Arbitrary for generating a list of IndexEntries
  const indexArb = fc.array(indexEntryArb, { minLength: 5, maxLength: 50 });

  // Arbitrary for generating search queries (substrings of names or partial matches)
  const queryArb = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ '.split('')),
    { minLength: 1, maxLength: 15 }
  ).filter(s => s.trim().length > 0);

  it('should return only results with Fuse.js score at or below the threshold (lower is better)', () => {
    fc.assert(
      fc.property(indexArb, queryArb, (entries, query) => {
        // Run the same search using Fuse.js directly with includeScore to verify scores
        const fuse = new Fuse(entries, {
          keys: ['name'],
          threshold: FUSE_THRESHOLD,
          includeScore: true,
          shouldSort: true,
          minMatchCharLength: 1,
        });

        const fuseResults = fuse.search(query, { limit: 20 });

        // All results returned by Fuse should have score <= threshold
        for (const result of fuseResults) {
          expect(result.score).toBeDefined();
          expect(result.score!).toBeLessThanOrEqual(FUSE_THRESHOLD);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should return the same results as a direct Fuse.js search with the same config', () => {
    fc.assert(
      fc.property(indexArb, queryArb, (entries, query) => {
        // Use MetadataSearch class
        const searcher = new MetadataSearch(entries);
        const searchResults = searcher.search(query);

        // Use Fuse.js directly with same config
        const fuse = new Fuse(entries, {
          keys: ['name'],
          threshold: FUSE_THRESHOLD,
          includeScore: true,
          shouldSort: true,
          minMatchCharLength: 1,
        });
        const fuseResults = fuse.search(query, { limit: 20 });
        const fuseItems = fuseResults.map(r => r.item);

        // Results should match
        expect(searchResults.length).toBe(fuseItems.length);
        for (let i = 0; i < searchResults.length; i++) {
          expect(searchResults[i].id).toBe(fuseItems[i].id);
          expect(searchResults[i].name).toBe(fuseItems[i].name);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should return exact matches when query matches an entry name exactly', () => {
    fc.assert(
      fc.property(indexArb, (entries) => {
        if (entries.length === 0) return;

        // Pick a random entry name as the query
        const targetIndex = Math.floor(Math.random() * entries.length);
        const exactQuery = entries[targetIndex].name;

        const searcher = new MetadataSearch(entries);
        const results = searcher.search(exactQuery);

        // The exact match should be in the results
        const foundExact = results.some(r => r.name === exactQuery);
        expect(foundExact).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should return empty array for empty or whitespace-only queries', () => {
    fc.assert(
      fc.property(
        indexArb,
        fc.constantFrom('', '   ', '\t', '\n'),
        (entries, query) => {
          const searcher = new MetadataSearch(entries);
          const results = searcher.search(query);
          expect(results).toEqual([]);
        }
      ),
      { numRuns: 20 }
    );
  });
});
