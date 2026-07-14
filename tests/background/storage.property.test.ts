/**
 * Property Test: Org Isolation (Property 4)
 *
 * Property 4: Org isolation — index queries return only current org data
 * For any two distinct org IDs and their respective indices stored in local
 * storage, querying the index for org A shall never return entries belonging
 * to org B.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 4: Org isolation — index queries return only current org data
 * Validates: Requirements 9.2, 9.3
 */

import * as fc from 'fast-check';
import { OrgIndex, IndexEntry, MetadataType } from '../../src/shared/types';
import { getStorageKey, saveOrgIndex, loadOrgIndex } from '../../src/background/storage';

// ---------------------------------------------------------------------------
// Mock Chrome Storage API
// ---------------------------------------------------------------------------

const mockStorage: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: jest.fn(async (key: string) => {
        return { [key]: mockStorage[key] ?? undefined };
      }),
      set: jest.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items);
      }),
      remove: jest.fn(async (key: string) => {
        delete mockStorage[key];
      }),
    },
  },
};

// Assign mock to global
(global as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

describe('Property 4: Org isolation — index queries return only current org data', () => {
  // Arbitrary for generating valid 15-char org IDs (start with 00D)
  const orgIdArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 12, maxLength: 12 }
  ).map(s => '00D' + s);

  // Arbitrary for generating distinct pairs of org IDs
  const distinctOrgIdPairArb = fc.tuple(orgIdArb, orgIdArb).filter(
    ([a, b]) => a !== b
  );

  // Supported metadata types
  const metadataTypes: MetadataType[] = [
    'Profile', 'PermissionSet', 'Flow', 'EmailTemplate',
    'Layout', 'ValidationRule', 'ApexClass',
  ];

  // Arbitrary for generating IndexEntry arrays
  const indexEntryArb = fc.record({
    id: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 18, maxLength: 18 }),
    name: fc.string({ minLength: 1, maxLength: 40 }),
    type: fc.constantFrom(...metadataTypes),
    typeLabel: fc.string({ minLength: 1, maxLength: 20 }),
    url: fc.string({ minLength: 5, maxLength: 80 }).map(s => '/lightning/setup/' + s),
  }) as fc.Arbitrary<IndexEntry>;

  const indexEntriesArb = fc.array(indexEntryArb, { minLength: 1, maxLength: 10 });

  beforeEach(() => {
    // Clear mock storage between tests
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
    jest.clearAllMocks();
  });

  it('should generate distinct storage keys for distinct org IDs', () => {
    fc.assert(
      fc.property(distinctOrgIdPairArb, ([orgA, orgB]) => {
        const keyA = getStorageKey(orgA);
        const keyB = getStorageKey(orgB);
        expect(keyA).not.toBe(keyB);
      }),
      { numRuns: 100 }
    );
  });

  it('should store and retrieve entries only for the correct org', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctOrgIdPairArb,
        indexEntriesArb,
        indexEntriesArb,
        async ([orgIdA, orgIdB], entriesA, entriesB) => {
          // Clear storage
          for (const key of Object.keys(mockStorage)) {
            delete mockStorage[key];
          }

          // Save indices for both orgs
          const indexA: OrgIndex = {
            orgId: orgIdA,
            instanceUrl: 'https://orga.salesforce.com',
            entries: entriesA,
            lastRefreshed: Date.now(),
            version: 1,
          };

          const indexB: OrgIndex = {
            orgId: orgIdB,
            instanceUrl: 'https://orgb.salesforce.com',
            entries: entriesB,
            lastRefreshed: Date.now(),
            version: 1,
          };

          await saveOrgIndex(indexA);
          await saveOrgIndex(indexB);

          // Load org A's index
          const loadedA = await loadOrgIndex(orgIdA);
          expect(loadedA).not.toBeNull();
          expect(loadedA!.orgId).toBe(orgIdA);
          expect(loadedA!.entries).toEqual(entriesA);

          // Load org B's index
          const loadedB = await loadOrgIndex(orgIdB);
          expect(loadedB).not.toBeNull();
          expect(loadedB!.orgId).toBe(orgIdB);
          expect(loadedB!.entries).toEqual(entriesB);

          // Verify no cross-contamination: A's entries are not in B's index
          for (const entryA of loadedA!.entries) {
            const foundInB = loadedB!.entries.some(
              (entryB) => entryB.id === entryA.id && entryB.name === entryA.name
            );
            // Only assert no overlap if entries are actually distinct
            if (!entriesB.some(e => e.id === entryA.id && e.name === entryA.name)) {
              expect(foundInB).toBe(false);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('should return null when loading an org that has no stored index', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctOrgIdPairArb,
        indexEntriesArb,
        async ([orgIdA, orgIdB], entriesA) => {
          // Clear storage
          for (const key of Object.keys(mockStorage)) {
            delete mockStorage[key];
          }

          // Only save org A
          const indexA: OrgIndex = {
            orgId: orgIdA,
            instanceUrl: 'https://orga.salesforce.com',
            entries: entriesA,
            lastRefreshed: Date.now(),
            version: 1,
          };

          await saveOrgIndex(indexA);

          // Loading org B should return null
          const loadedB = await loadOrgIndex(orgIdB);
          expect(loadedB).toBeNull();

          // Loading org A should still work
          const loadedA = await loadOrgIndex(orgIdA);
          expect(loadedA).not.toBeNull();
          expect(loadedA!.orgId).toBe(orgIdA);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('should not affect other orgs when overwriting one org index', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctOrgIdPairArb,
        indexEntriesArb,
        indexEntriesArb,
        indexEntriesArb,
        async ([orgIdA, orgIdB], entriesA, entriesB, newEntriesA) => {
          // Clear storage
          for (const key of Object.keys(mockStorage)) {
            delete mockStorage[key];
          }

          // Save both orgs
          await saveOrgIndex({
            orgId: orgIdA,
            instanceUrl: 'https://orga.salesforce.com',
            entries: entriesA,
            lastRefreshed: Date.now(),
            version: 1,
          });
          await saveOrgIndex({
            orgId: orgIdB,
            instanceUrl: 'https://orgb.salesforce.com',
            entries: entriesB,
            lastRefreshed: Date.now(),
            version: 1,
          });

          // Overwrite org A with new entries
          await saveOrgIndex({
            orgId: orgIdA,
            instanceUrl: 'https://orga.salesforce.com',
            entries: newEntriesA,
            lastRefreshed: Date.now(),
            version: 1,
          });

          // Org B should be unaffected
          const loadedB = await loadOrgIndex(orgIdB);
          expect(loadedB).not.toBeNull();
          expect(loadedB!.entries).toEqual(entriesB);

          // Org A should have new entries
          const loadedA = await loadOrgIndex(orgIdA);
          expect(loadedA!.entries).toEqual(newEntriesA);
        }
      ),
      { numRuns: 50 }
    );
  });
});
