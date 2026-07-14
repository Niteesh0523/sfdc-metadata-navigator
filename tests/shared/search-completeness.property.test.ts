/**
 * Property Test: Result Completeness (Property 3)
 *
 * Property 3: Search results always include both name and type
 * For any search result returned to the user, both the metadata item name
 * and its metadata type label must be present and non-empty.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 3: Search results always include both name and type
 * Validates: Requirements 4.3
 */

import * as fc from 'fast-check';
import { IndexEntry, MetadataType } from '../../src/shared/types';
import { MetadataSearch } from '../../src/popup/search';

describe('Property 3: Search results always include both name and type', () => {
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

  // Arbitrary for non-empty metadata names
  const metadataNameArb = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ -'.split('')),
    { minLength: 2, maxLength: 40 }
  ).filter(s => s.trim().length > 0);

  const idArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 18, maxLength: 18 }
  );

  // Arbitrary for generating valid IndexEntry with non-empty name and typeLabel
  const validEntryArb = fc.tuple(
    metadataNameArb,
    fc.constantFrom(...metadataTypes),
    idArb
  ).map(([name, type, id]): IndexEntry => ({
    id,
    name,
    type,
    typeLabel: typeLabels[type],
    url: `/lightning/setup/Test/${id}`,
  }));

  // Arbitrary for generating a list of valid entries
  const validIndexArb = fc.array(validEntryArb, { minLength: 5, maxLength: 50 });

  // Search query that's likely to match (use a substring from generated names)
  const queryArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 1, maxLength: 10 }
  ).filter(s => s.trim().length > 0);

  it('should ensure every returned result has a non-empty name', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (entries, query) => {
        const searcher = new MetadataSearch(entries);
        const results = searcher.search(query);

        for (const result of results) {
          expect(result.name).toBeDefined();
          expect(typeof result.name).toBe('string');
          expect(result.name.trim().length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should ensure every returned result has a non-empty typeLabel', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (entries, query) => {
        const searcher = new MetadataSearch(entries);
        const results = searcher.search(query);

        for (const result of results) {
          expect(result.typeLabel).toBeDefined();
          expect(typeof result.typeLabel).toBe('string');
          expect(result.typeLabel.trim().length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should ensure every returned result has a valid metadata type', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (entries, query) => {
        const searcher = new MetadataSearch(entries);
        const results = searcher.search(query);

        for (const result of results) {
          expect(metadataTypes).toContain(result.type);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should ensure every returned result has a non-empty id and url', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (entries, query) => {
        const searcher = new MetadataSearch(entries);
        const results = searcher.search(query);

        for (const result of results) {
          expect(result.id).toBeDefined();
          expect(result.id.length).toBeGreaterThan(0);
          expect(result.url).toBeDefined();
          expect(result.url.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should never return entries with empty names even if they exist in the index', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (validEntries, query) => {
        // Add some entries with empty names to the index
        const entriesWithBlanks: IndexEntry[] = [
          ...validEntries,
          {
            id: 'empty_name_001000000000001',
            name: '',
            type: 'Profile',
            typeLabel: 'Profile',
            url: '/lightning/setup/Profiles/empty',
          },
          {
            id: 'whitespace_001000000000002',
            name: '   ',
            type: 'Flow',
            typeLabel: 'Flow',
            url: '/lightning/setup/Flows/ws',
          },
        ];

        const searcher = new MetadataSearch(entriesWithBlanks);
        const results = searcher.search(query);

        // No result should have an empty or whitespace-only name
        for (const result of results) {
          expect(result.name.trim().length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should produce results that are a subset of the input index entries', () => {
    fc.assert(
      fc.property(validIndexArb, queryArb, (entries, query) => {
        const searcher = new MetadataSearch(entries);
        const results = searcher.search(query);

        // Every result must exist in the original entries
        const entryIds = new Set(entries.map(e => e.id));
        for (const result of results) {
          expect(entryIds.has(result.id)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});
