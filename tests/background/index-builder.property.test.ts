/**
 * Property Test: Index Builder Partial Failure Handling (Property 8)
 *
 * Property 8: Empty/failed metadata retrieval produces empty index (not error)
 * For any metadata type whose API query returns an error or empty result set,
 * the index builder shall include zero entries for that type while preserving
 * entries from other successfully-fetched types.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 8: Empty/failed metadata retrieval produces empty index (not error)
 * Validates: Requirements 2.3
 */

import * as fc from 'fast-check';
import { MetadataType } from '../../src/shared/types';
import { buildIndex } from '../../src/background/index-builder';

// Mock the API module
jest.mock('../../src/background/api', () => ({
  queryRestApi: jest.fn(),
  queryToolingApi: jest.fn(),
  SessionExpiredError: class extends Error { constructor() { super('session expired'); this.name = 'SessionExpiredError'; } },
  RateLimitError: class extends Error { constructor() { super('rate limit'); this.name = 'RateLimitError'; } },
  ServerError: class extends Error { constructor() { super('server error'); this.name = 'ServerError'; } },
  ApiTimeoutError: class extends Error { constructor() { super('timeout'); this.name = 'ApiTimeoutError'; } },
}));

import { queryRestApi, queryToolingApi } from '../../src/background/api';

const mockedQueryRestApi = queryRestApi as jest.MockedFunction<typeof queryRestApi>;
const mockedQueryToolingApi = queryToolingApi as jest.MockedFunction<typeof queryToolingApi>;

describe('Property 8: Empty/failed metadata retrieval produces empty index (not error)', () => {
  const ALL_TYPES: MetadataType[] = [
    'Profile', 'PermissionSet', 'Flow', 'EmailTemplate',
    'Layout', 'ValidationRule', 'ApexClass',
  ];

  // Which types use REST vs Tooling API
  const REST_TYPES: MetadataType[] = ['Profile', 'PermissionSet', 'EmailTemplate'];
  const TOOLING_TYPES: MetadataType[] = ['Flow', 'Layout', 'ValidationRule', 'ApexClass'];

  // Generate a mock record for a given type
  function mockRecordForType(type: MetadataType, id: string) {
    switch (type) {
      case 'Profile':
        return { Id: id, Name: `Profile_${id}` };
      case 'PermissionSet':
        return { Id: id, Name: `PS_${id}`, Label: `PermSet ${id}` };
      case 'Flow':
        return { Id: id, MasterLabel: `Flow_${id}`, ProcessType: 'AutoLaunchedFlow' };
      case 'EmailTemplate':
        return { Id: id, Name: `Template_${id}`, FolderName: 'Folder' };
      case 'Layout':
        return { Id: id, Name: `Layout_${id}`, TableEnumOrId: 'Account' };
      case 'ValidationRule':
        return { Id: id, ValidationName: `Rule_${id}`, EntityDefinition: { QualifiedApiName: 'Account' } };
      case 'ApexClass':
        return { Id: id, Name: `Class_${id}`, NamespacePrefix: null };
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Map each type to a unique string in its SOQL FROM clause
  const SOQL_IDENTIFIERS: Record<MetadataType, string> = {
    Profile: 'FROM Profile',
    PermissionSet: 'FROM PermissionSet',
    Flow: 'FROM Flow',
    EmailTemplate: 'FROM EmailTemplate',
    Layout: 'FROM Layout',
    ValidationRule: 'FROM ValidationRule',
    ApexClass: 'FROM ApexClass',
  };

  /**
   * Determines which MetadataType a SOQL query belongs to based on its FROM clause.
   */
  function identifyTypeFromSoql(soql: string): MetadataType | null {
    // Check in a specific order to avoid ambiguity
    if (soql.includes('FROM PermissionSet')) return 'PermissionSet';
    if (soql.includes('FROM Profile')) return 'Profile';
    if (soql.includes('FROM Flow')) return 'Flow';
    if (soql.includes('FROM EmailTemplate')) return 'EmailTemplate';
    if (soql.includes('FROM Layout')) return 'Layout';
    if (soql.includes('FROM ValidationRule')) return 'ValidationRule';
    if (soql.includes('FROM ApexClass')) return 'ApexClass';
    return null;
  }

  /**
   * Configures mocks so that types in `successTypes` return records and
   * types in `failTypes` throw errors.
   */
  function configureMocks(
    successTypes: MetadataType[],
    failTypes: MetadataType[],
    recordsPerType: number
  ) {
    // Build records for successful types
    const recordsByType = new Map<MetadataType, ReturnType<typeof mockRecordForType>[]>();
    for (const type of successTypes) {
      const records = [];
      for (let i = 0; i < recordsPerType; i++) {
        records.push(mockRecordForType(type, `${type}_${i}_00D000000000001`));
      }
      recordsByType.set(type, records);
    }

    // Configure REST API mock
    mockedQueryRestApi.mockImplementation(async (_url, _session, soql) => {
      const type = identifyTypeFromSoql(soql);
      if (type && failTypes.includes(type)) {
        throw new Error(`Simulated failure for ${type}`);
      }
      if (type) {
        return recordsByType.get(type) || [];
      }
      return [];
    });

    // Configure Tooling API mock
    mockedQueryToolingApi.mockImplementation(async (_url, _session, soql) => {
      const type = identifyTypeFromSoql(soql);
      if (type && failTypes.includes(type)) {
        throw new Error(`Simulated failure for ${type}`);
      }
      if (type) {
        return recordsByType.get(type) || [];
      }
      return [];
    });
  }

  it('should return entries for successful types and zero entries for failed types', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Pick a random non-empty subset to fail
        fc.subarray(ALL_TYPES, { minLength: 1, maxLength: ALL_TYPES.length - 1 }),
        fc.integer({ min: 1, max: 5 }),
        async (failTypes, recordCount) => {
          const successTypes = ALL_TYPES.filter(t => !failTypes.includes(t));
          configureMocks(successTypes, failTypes, recordCount);

          const entries = await buildIndex(
            'https://test.salesforce.com',
            'fake-session-id',
            ALL_TYPES
          );

          // Entries should only contain items from successful types
          for (const entry of entries) {
            expect(successTypes).toContain(entry.type);
            expect(failTypes).not.toContain(entry.type);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('should not throw when all metadata types fail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (_seed) => {
          // All types fail
          configureMocks([], ALL_TYPES, 0);

          const entries = await buildIndex(
            'https://test.salesforce.com',
            'fake-session-id',
            ALL_TYPES
          );

          // Should return empty array, not throw
          expect(entries).toEqual([]);
        }
      ),
      { numRuns: 10 }
    );
  });

  it('should preserve all entries from successful types regardless of which types fail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(ALL_TYPES, { minLength: 1, maxLength: ALL_TYPES.length }),
        fc.integer({ min: 1, max: 3 }),
        async (successSubset, recordCount) => {
          const failSubset = ALL_TYPES.filter(t => !successSubset.includes(t));
          configureMocks(successSubset, failSubset, recordCount);

          const entries = await buildIndex(
            'https://test.salesforce.com',
            'fake-session-id',
            ALL_TYPES
          );

          // Count entries per successful type
          for (const type of successSubset) {
            const typeEntries = entries.filter(e => e.type === type);
            expect(typeEntries.length).toBe(recordCount);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('should only query types in enabledTypes (not all types)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(ALL_TYPES, { minLength: 1, maxLength: ALL_TYPES.length }),
        async (enabledTypes) => {
          // All enabled types succeed
          configureMocks(enabledTypes, [], 1);

          const entries = await buildIndex(
            'https://test.salesforce.com',
            'fake-session-id',
            enabledTypes
          );

          // Only enabled types should appear in results
          const resultTypes = new Set(entries.map(e => e.type));
          for (const type of resultTypes) {
            expect(enabledTypes).toContain(type);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
