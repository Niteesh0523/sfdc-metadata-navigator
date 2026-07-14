import { getStorageKey, saveOrgIndex, loadOrgIndex, deleteOrgIndex } from '../../src/background/storage';
import { OrgIndex } from '../../src/shared/types';

// Mock Chrome storage API
const mockStorage: Record<string, unknown> = {};

const mockSet = jest.fn(async (items: Record<string, unknown>) => {
  Object.assign(mockStorage, items);
});

const mockGet = jest.fn(async (key: string) => {
  if (key in mockStorage) {
    return { [key]: mockStorage[key] };
  }
  return {};
});

const mockRemove = jest.fn(async (key: string) => {
  delete mockStorage[key];
});

beforeAll(() => {
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        set: mockSet,
        get: mockGet,
        remove: mockRemove,
      },
    },
  };
});

describe('storage manager', () => {
  beforeEach(() => {
    // Clear mock storage and call history before each test
    Object.keys(mockStorage).forEach(key => delete mockStorage[key]);
    mockSet.mockClear();
    mockGet.mockClear();
    mockRemove.mockClear();
  });

  describe('getStorageKey', () => {
    it('returns key with index_ prefix followed by orgId', () => {
      const key = getStorageKey('00D000000000001');
      expect(key).toBe('index_00D000000000001');
    });

    it('uses the STORAGE_KEY_PREFIX constant pattern', () => {
      const orgId = '00Dxx0000001234';
      const key = getStorageKey(orgId);
      expect(key).toMatch(/^index_/);
      expect(key).toBe(`index_${orgId}`);
    });

    it('handles different org ID formats consistently', () => {
      expect(getStorageKey('00D5g000004AAAA')).toBe('index_00D5g000004AAAA');
      expect(getStorageKey('00Dbf0000066dT3')).toBe('index_00Dbf0000066dT3');
    });
  });

  describe('saveOrgIndex', () => {
    it('saves the OrgIndex to chrome.storage.local with the correct key', async () => {
      const orgIndex: OrgIndex = {
        orgId: '00D000000000001',
        instanceUrl: 'https://myorg.lightning.force.com',
        entries: [],
        lastRefreshed: Date.now(),
        version: 1,
      };

      await saveOrgIndex(orgIndex);

      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith({ 'index_00D000000000001': orgIndex });
    });

    it('stores lastRefreshed timestamp and schema version', async () => {
      const timestamp = 1717200000000;
      const orgIndex: OrgIndex = {
        orgId: '00D000000000002',
        instanceUrl: 'https://other.lightning.force.com',
        entries: [
          {
            id: '01p000000000001',
            name: 'Test Profile',
            type: 'Profile',
            typeLabel: 'Profile',
            url: '/lightning/setup/EnhancedProfiles/page?address=/01p000000000001',
          },
        ],
        lastRefreshed: timestamp,
        version: 1,
      };

      await saveOrgIndex(orgIndex);

      const storedValue = mockStorage['index_00D000000000002'] as OrgIndex;
      expect(storedValue.lastRefreshed).toBe(timestamp);
      expect(storedValue.version).toBe(1);
    });
  });

  describe('loadOrgIndex', () => {
    it('returns the stored OrgIndex when it exists', async () => {
      const orgIndex: OrgIndex = {
        orgId: '00D000000000001',
        instanceUrl: 'https://myorg.lightning.force.com',
        entries: [
          {
            id: '300000000000001',
            name: 'My Flow',
            type: 'Flow',
            typeLabel: 'Flow',
            url: '/lightning/setup/Flows/page?address=/300000000000001',
          },
        ],
        lastRefreshed: 1717200000000,
        version: 1,
      };

      // Pre-populate the mock storage
      mockStorage['index_00D000000000001'] = orgIndex;

      const result = await loadOrgIndex('00D000000000001');

      expect(mockGet).toHaveBeenCalledWith('index_00D000000000001');
      expect(result).toEqual(orgIndex);
    });

    it('returns null when no index exists for the given org', async () => {
      const result = await loadOrgIndex('00D999999999999');

      expect(mockGet).toHaveBeenCalledWith('index_00D999999999999');
      expect(result).toBeNull();
    });

    it('round-trips correctly when saving then loading', async () => {
      const orgIndex: OrgIndex = {
        orgId: '00D000000000005',
        instanceUrl: 'https://roundtrip.lightning.force.com',
        entries: [
          {
            id: '01p000000000010',
            name: 'Admin',
            type: 'Profile',
            typeLabel: 'Profile',
            url: '/lightning/setup/EnhancedProfiles/page?address=/01p000000000010',
          },
          {
            id: '0PS000000000001',
            name: 'Sales User PS',
            type: 'PermissionSet',
            typeLabel: 'Permission Set',
            url: '/lightning/setup/PermSets/page?address=/0PS000000000001',
          },
        ],
        lastRefreshed: 1717300000000,
        version: 1,
      };

      await saveOrgIndex(orgIndex);
      const loaded = await loadOrgIndex('00D000000000005');

      expect(loaded).toEqual(orgIndex);
    });
  });

  describe('deleteOrgIndex', () => {
    it('removes the index from chrome.storage.local', async () => {
      // Pre-populate the mock storage
      mockStorage['index_00D000000000001'] = {
        orgId: '00D000000000001',
        instanceUrl: 'https://myorg.lightning.force.com',
        entries: [],
        lastRefreshed: Date.now(),
        version: 1,
      };

      await deleteOrgIndex('00D000000000001');

      expect(mockRemove).toHaveBeenCalledWith('index_00D000000000001');
      expect(mockStorage['index_00D000000000001']).toBeUndefined();
    });

    it('does not throw when deleting a non-existent index', async () => {
      await expect(deleteOrgIndex('00D999999999999')).resolves.not.toThrow();
      expect(mockRemove).toHaveBeenCalledWith('index_00D999999999999');
    });
  });
});
