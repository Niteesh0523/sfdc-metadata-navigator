/**
 * Unit tests for the Index Builder module.
 *
 * Verifies:
 * - Successful index building from multiple metadata types
 * - Partial failure handling (one type fails, others succeed)
 * - Empty name entries are filtered out
 * - Correct type labels are assigned
 * - Total timeout aborts remaining queries
 */

import { buildIndex, TYPE_LABELS } from '../../src/background/index-builder';
import { queryRestApi, queryToolingApi } from '../../src/background/api';
import { MetadataType, SalesforceRecord } from '../../src/shared/types';
import { REFRESH_TIMEOUT } from '../../src/shared/constants';

// Mock the API module
jest.mock('../../src/background/api', () => ({
  queryRestApi: jest.fn(),
  queryToolingApi: jest.fn(),
}));

const mockedQueryRestApi = queryRestApi as jest.MockedFunction<typeof queryRestApi>;
const mockedQueryToolingApi = queryToolingApi as jest.MockedFunction<typeof queryToolingApi>;

describe('Index Builder', () => {
  const instanceUrl = 'https://mycompany.lightning.force.com';
  const sessionId = 'test-session-id-123';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('buildIndex', () => {
    it('successfully builds entries from multiple metadata types', async () => {
      // Arrange: Profile uses REST, Flow uses TOOLING
      const profileRecords: SalesforceRecord[] = [
        { Id: '00e000000000001', Name: 'System Administrator' },
        { Id: '00e000000000002', Name: 'Standard User' },
      ];
      const flowRecords: SalesforceRecord[] = [
        { Id: '301000000000001', MasterLabel: 'Lead Assignment Flow' },
      ];

      mockedQueryRestApi.mockResolvedValue(profileRecords);
      mockedQueryToolingApi.mockResolvedValue(flowRecords);

      // Act
      const entries = await buildIndex(instanceUrl, sessionId, ['Profile', 'Flow']);

      // Assert
      expect(entries).toHaveLength(3);

      // Verify Profile entries
      const profileEntries = entries.filter(e => e.type === 'Profile');
      expect(profileEntries).toHaveLength(2);
      expect(profileEntries[0].name).toBe('System Administrator');
      expect(profileEntries[0].id).toBe('00e000000000001');
      expect(profileEntries[0].typeLabel).toBe('Profile');
      expect(profileEntries[0].url).toContain('00e000000000001');

      // Verify Flow entries
      const flowEntries = entries.filter(e => e.type === 'Flow');
      expect(flowEntries).toHaveLength(1);
      expect(flowEntries[0].name).toBe('Lead Assignment Flow');
      expect(flowEntries[0].typeLabel).toBe('Flow');

      // Verify correct API was called for each type
      expect(mockedQueryRestApi).toHaveBeenCalledTimes(1);
      expect(mockedQueryToolingApi).toHaveBeenCalledTimes(1);
    });

    it('handles partial failure: one type fails but others succeed', async () => {
      // Arrange: Profile succeeds, PermissionSet throws
      const profileRecords: SalesforceRecord[] = [
        { Id: '00e000000000001', Name: 'Admin' },
      ];

      mockedQueryRestApi
        .mockResolvedValueOnce(profileRecords) // Profile succeeds
        .mockRejectedValueOnce(new Error('API rate limit exceeded')); // PermissionSet fails

      // Act
      const entries = await buildIndex(instanceUrl, sessionId, ['Profile', 'PermissionSet']);

      // Assert: only Profile entries are returned, no error thrown
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('Profile');
      expect(entries[0].name).toBe('Admin');
    });

    it('filters out entries where name is empty', async () => {
      // Arrange: records where some have empty names
      const records: SalesforceRecord[] = [
        { Id: '00e000000000001', Name: 'Valid Profile' },
        { Id: '00e000000000002', Name: '' },
        { Id: '00e000000000003', Name: '   ' }, // whitespace only
      ];

      mockedQueryRestApi.mockResolvedValue(records);

      // Act
      const entries = await buildIndex(instanceUrl, sessionId, ['Profile']);

      // Assert: only the entry with a valid name is included
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Valid Profile');
    });

    it('assigns correct type labels for all metadata types', async () => {
      // Arrange: one record for each type
      const profileRecords: SalesforceRecord[] = [{ Id: '001', Name: 'Admin' }];
      const permSetRecords: SalesforceRecord[] = [{ Id: '002', Label: 'My Perm Set', Name: 'MyPermSet' }];
      const flowRecords: SalesforceRecord[] = [{ Id: '003', MasterLabel: 'My Flow' }];
      const emailRecords: SalesforceRecord[] = [{ Id: '004', Name: 'Welcome Email' }];
      const layoutRecords: SalesforceRecord[] = [{ Id: '005', Name: 'Account Layout', TableEnumOrId: 'Account' }];
      const valRuleRecords: SalesforceRecord[] = [
        { Id: '006', ValidationName: 'Required Field', EntityDefinition: { QualifiedApiName: 'Account' } },
      ];
      const apexRecords: SalesforceRecord[] = [{ Id: '007', Name: 'MyController' }];

      // REST API handles Profile, PermissionSet, EmailTemplate
      mockedQueryRestApi
        .mockResolvedValueOnce(profileRecords)
        .mockResolvedValueOnce(permSetRecords)
        .mockResolvedValueOnce(emailRecords);

      // Tooling API handles Flow, Layout, ValidationRule, ApexClass
      mockedQueryToolingApi
        .mockResolvedValueOnce(flowRecords)
        .mockResolvedValueOnce(layoutRecords)
        .mockResolvedValueOnce(valRuleRecords)
        .mockResolvedValueOnce(apexRecords);

      const allTypes: MetadataType[] = [
        'Profile', 'PermissionSet', 'Flow', 'EmailTemplate', 'Layout', 'ValidationRule', 'ApexClass',
      ];

      // Act
      const entries = await buildIndex(instanceUrl, sessionId, allTypes);

      // Assert correct type labels
      expect(entries).toHaveLength(7);

      const labelsByType = new Map(entries.map(e => [e.type, e.typeLabel]));
      expect(labelsByType.get('Profile')).toBe('Profile');
      expect(labelsByType.get('PermissionSet')).toBe('Permission Set');
      expect(labelsByType.get('Flow')).toBe('Flow');
      expect(labelsByType.get('EmailTemplate')).toBe('Email Template');
      expect(labelsByType.get('Layout')).toBe('Page Layout');
      expect(labelsByType.get('ValidationRule')).toBe('Validation Rule');
      expect(labelsByType.get('ApexClass')).toBe('Apex Class');
    });

    it('total timeout aborts remaining queries', async () => {
      // Arrange: mock Date.now() to simulate time passing beyond REFRESH_TIMEOUT
      const realDateNow = Date.now;
      let callCount = 0;
      const startTime = 1000000;

      jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // First call (start): returns startTime
        // Second call (before first type): returns startTime (within timeout)
        // Third call (before second type): returns startTime + REFRESH_TIMEOUT (exceeds timeout)
        if (callCount <= 2) {
          return startTime;
        }
        return startTime + REFRESH_TIMEOUT;
      });

      const profileRecords: SalesforceRecord[] = [
        { Id: '00e000000000001', Name: 'Admin' },
      ];

      mockedQueryRestApi.mockResolvedValue(profileRecords);
      mockedQueryToolingApi.mockResolvedValue([]);

      // Act: request both Profile and Flow, but timeout should prevent Flow from being queried
      const entries = await buildIndex(instanceUrl, sessionId, ['Profile', 'Flow']);

      // Assert: only Profile entries are present (Flow was aborted due to timeout)
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('Profile');

      // Tooling API should not have been called (Flow uses TOOLING)
      expect(mockedQueryToolingApi).not.toHaveBeenCalled();
    });

    it('returns empty array when all types fail', async () => {
      // Arrange: both types throw
      mockedQueryRestApi.mockRejectedValue(new Error('Network error'));
      mockedQueryToolingApi.mockRejectedValue(new Error('Timeout'));

      // Act
      const entries = await buildIndex(instanceUrl, sessionId, ['Profile', 'Flow']);

      // Assert
      expect(entries).toHaveLength(0);
    });

    it('returns empty array when enabledTypes is empty', async () => {
      // Act
      const entries = await buildIndex(instanceUrl, sessionId, []);

      // Assert
      expect(entries).toHaveLength(0);
      expect(mockedQueryRestApi).not.toHaveBeenCalled();
      expect(mockedQueryToolingApi).not.toHaveBeenCalled();
    });

    it('includes objectName for Layout entries', async () => {
      const layoutRecords: SalesforceRecord[] = [
        { Id: '00h000000000001', Name: 'Account Layout', TableEnumOrId: 'Account' },
      ];

      mockedQueryToolingApi.mockResolvedValue(layoutRecords);

      const entries = await buildIndex(instanceUrl, sessionId, ['Layout']);

      expect(entries).toHaveLength(1);
      expect(entries[0].objectName).toBe('Account');
    });

    it('includes objectName for ValidationRule entries', async () => {
      const valRuleRecords: SalesforceRecord[] = [
        {
          Id: '03d000000000001',
          ValidationName: 'Required Close Date',
          EntityDefinition: { QualifiedApiName: 'Opportunity' },
        },
      ];

      mockedQueryToolingApi.mockResolvedValue(valRuleRecords);

      const entries = await buildIndex(instanceUrl, sessionId, ['ValidationRule']);

      expect(entries).toHaveLength(1);
      expect(entries[0].objectName).toBe('Opportunity');
    });
  });

  describe('TYPE_LABELS', () => {
    it('contains labels for all supported metadata types', () => {
      const expectedTypes: MetadataType[] = [
        'Profile', 'PermissionSet', 'Flow', 'EmailTemplate', 'Layout', 'ValidationRule', 'ApexClass',
      ];

      for (const type of expectedTypes) {
        expect(TYPE_LABELS[type]).toBeDefined();
        expect(TYPE_LABELS[type].length).toBeGreaterThan(0);
      }
    });

    it('has correct human-readable labels', () => {
      expect(TYPE_LABELS.Profile).toBe('Profile');
      expect(TYPE_LABELS.PermissionSet).toBe('Permission Set');
      expect(TYPE_LABELS.Flow).toBe('Flow');
      expect(TYPE_LABELS.EmailTemplate).toBe('Email Template');
      expect(TYPE_LABELS.Layout).toBe('Page Layout');
      expect(TYPE_LABELS.ValidationRule).toBe('Validation Rule');
      expect(TYPE_LABELS.ApexClass).toBe('Apex Class');
    });
  });
});
