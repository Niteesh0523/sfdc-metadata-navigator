/**
 * Integration Tests: Message Passing & Refresh Flow
 *
 * Tests the full communication protocol between popup ↔ service worker ↔
 * content script with mocked Chrome APIs and Salesforce API responses.
 *
 * Feature: sfdc-metadata-navigator-extension
 * Validates: Requirements 3.1, 3.3, 8.2, 8.3
 */

import { MetadataType, OrgIndex, UserSettings } from '../../src/shared/types';
import { SETTINGS_KEY, STORAGE_KEY_PREFIX, ALL_METADATA_TYPES } from '../../src/shared/constants';

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

// In-memory storages
const mockLocalStorage: Record<string, unknown> = {};
const mockSyncStorage: Record<string, unknown> = {};
const mockCookies: Record<string, { value: string }> = {};

// Message listeners registry
type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | void;

const messageListeners: MessageListener[] = [];
const tabMessageHandlers: Map<number, MessageListener> = new Map();

// Chrome API mock
const chromeMock = {
  runtime: {
    onMessage: {
      addListener: jest.fn((listener: MessageListener) => {
        messageListeners.push(listener);
      }),
    },
    sendMessage: jest.fn(async (message: unknown) => {
      // Simulate routing to background service worker listeners
      return new Promise((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            message,
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            (response: unknown) => resolve(response)
          );
          if (returned === true) return; // async response will be sent
        }
        resolve(undefined);
      });
    }),
  },
  tabs: {
    query: jest.fn(async () => [{ id: 1, url: 'https://myorg.lightning.force.com/lightning/setup/home' }]),
    sendMessage: jest.fn(async (tabId: number, message: unknown) => {
      const handler = tabMessageHandlers.get(tabId);
      if (handler) {
        return new Promise((resolve) => {
          handler(message, {} as chrome.runtime.MessageSender, (response: unknown) => resolve(response));
        });
      }
      throw new Error('Could not establish connection');
    }),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  },
  storage: {
    local: {
      get: jest.fn(async (key: string) => ({ [key]: mockLocalStorage[key] ?? undefined })),
      set: jest.fn(async (items: Record<string, unknown>) => { Object.assign(mockLocalStorage, items); }),
      remove: jest.fn(async (key: string) => { delete mockLocalStorage[key]; }),
    },
    sync: {
      get: jest.fn(async (key: string) => ({ [key]: mockSyncStorage[key] ?? undefined })),
      set: jest.fn(async (items: Record<string, unknown>) => { Object.assign(mockSyncStorage, items); }),
    },
  },
  cookies: {
    get: jest.fn(async (details: { url: string; name: string }) => {
      const key = `${details.url}|${details.name}`;
      return mockCookies[key] || null;
    }),
    getAll: jest.fn(async (details: { name?: string; domain?: string; secure?: boolean }) => {
      // Return cookies matching the filter from our mock store
      const results: Array<{ value: string; domain: string; name: string }> = [];
      for (const [key, cookie] of Object.entries(mockCookies)) {
        const [url, name] = key.split('|');
        if (details.name && name !== details.name) continue;
        if (details.domain && !url.includes(details.domain)) continue;
        results.push({ value: cookie.value, domain: new URL(url).hostname, name });
      }
      return results;
    }),
  },
};

(global as any).chrome = chromeMock;

// Mock fetch for Salesforce API calls
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Now import modules (after global mocks are set up)
// We need to use require-style dynamic imports to ensure mocks are in place
let backgroundModule: typeof import('../../src/background/background');

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function clearAllStorage() {
  for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
  for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];
  for (const key of Object.keys(mockCookies)) delete mockCookies[key];
}

function setSessionCookie(domain: string, sessionId: string) {
  // The session module calls chrome.cookies.get({ url: 'https://domain', name: 'sid' })
  // getSession reads the sid cookie, extracts orgId prefix, then searches salesforce.com domain
  const orgId = sessionId.split('!')[0] || '00D000000000001';
  const fullSessionId = sessionId.includes('!') ? sessionId : `${orgId}!${sessionId}`;
  
  // Set cookie on the lightning domain (what the page has)
  mockCookies[`https://${domain}|sid`] = { value: fullSessionId, domain: domain } as any;
  
  // Also set on salesforce.com domain (where API-accessible session lives)
  const sfDomain = domain.replace('.lightning.force.com', '.my.salesforce.com');
  mockCookies[`https://${sfDomain}|sid`] = { value: fullSessionId, domain: sfDomain } as any;
}

function setDefaultSettings(settings?: Partial<UserSettings>) {
  const defaultSettings: UserSettings = {
    enabledTypes: ALL_METADATA_TYPES,
    maxResults: 20,
    version: 1,
    ...settings,
  };
  mockSyncStorage[SETTINGS_KEY] = defaultSettings;
}

function registerContentScript(tabId: number, orgId: string, instanceUrl: string) {
  tabMessageHandlers.set(tabId, (message, _sender, sendResponse) => {
    if ((message as any).action === 'getOrgInfo') {
      sendResponse({ orgId, instanceUrl });
    }
    return false;
  });
}

function mockSalesforceApiSuccess(instanceUrl: string) {
  mockFetch.mockImplementation(async (url: string) => {
    // Determine which metadata type is being queried
    const decodedUrl = decodeURIComponent(url);

    let records: unknown[] = [];

    if (decodedUrl.includes('FROM Profile')) {
      records = [
        { Id: '00e000000000001', Name: 'Admin' },
        { Id: '00e000000000002', Name: 'Standard User' },
      ];
    } else if (decodedUrl.includes('FROM PermissionSet')) {
      records = [
        { Id: '0PS000000000001', Name: 'ManageUsers', Label: 'Manage Users' },
      ];
    } else if (decodedUrl.includes('FROM Flow')) {
      records = [
        { Id: '301000000000001', MasterLabel: 'Account Handler', ProcessType: 'AutoLaunchedFlow' },
      ];
    } else if (decodedUrl.includes('FROM EmailTemplate')) {
      records = [
        { Id: '00X000000000001', Name: 'Welcome Email', FolderName: 'Onboarding' },
      ];
    } else if (decodedUrl.includes('FROM Layout')) {
      records = [
        { Id: '00h000000000001', Name: 'Account Layout', TableEnumOrId: 'Account' },
      ];
    } else if (decodedUrl.includes('FROM ValidationRule')) {
      records = [
        { Id: '03d000000000001', ValidationName: 'Require_Name', EntityDefinition: { QualifiedApiName: 'Account' } },
      ];
    } else if (decodedUrl.includes('FROM ApexClass')) {
      records = [
        { Id: '01p000000000001', Name: 'AccountService', NamespacePrefix: null },
      ];
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        totalSize: records.length,
        done: true,
        records,
      }),
    };
  });
}

function mockSalesforceApiSessionExpired() {
  mockFetch.mockImplementation(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: 'Session expired or invalid' }),
  }));
}

function mockSalesforceApiPartialFailure() {
  let callCount = 0;
  mockFetch.mockImplementation(async (url: string) => {
    callCount++;
    const decodedUrl = decodeURIComponent(url);

    // Fail on Flow queries, succeed on others
    if (decodedUrl.includes('FROM Flow')) {
      return { ok: false, status: 500, json: async () => ({ message: 'Internal error' }) };
    }

    if (decodedUrl.includes('FROM Profile')) {
      return {
        ok: true, status: 200,
        json: async () => ({ totalSize: 1, done: true, records: [{ Id: '00e000000000001', Name: 'Admin' }] }),
      };
    }

    // Default success with empty records
    return {
      ok: true, status: 200,
      json: async () => ({ totalSize: 0, done: true, records: [] }),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Message passing and refresh flow', () => {
  beforeEach(() => {
    clearAllStorage();
    messageListeners.length = 0;
    tabMessageHandlers.clear();
    jest.clearAllMocks();
    mockFetch.mockReset();

    // Re-register the background service worker listener
    // This simulates loading the background script
    jest.resetModules();
  });

  describe('Content Script ↔ Background communication', () => {
    it('should receive org info from content script via tab message', async () => {
      registerContentScript(1, '00D000000000001', 'https://myorg.lightning.force.com');

      const response = await chromeMock.tabs.sendMessage(1, { action: 'getOrgInfo' });

      expect(response).toEqual({
        orgId: '00D000000000001',
        instanceUrl: 'https://myorg.lightning.force.com',
      });
    });

    it('should handle content script not available (no handler registered)', async () => {
      // No content script registered for tab 99
      await expect(
        chromeMock.tabs.sendMessage(99, { action: 'getOrgInfo' })
      ).rejects.toThrow('Could not establish connection');
    });
  });

  describe('Popup ↔ Background refresh flow', () => {
    beforeEach(async () => {
      // Load the background module to register its message listeners
      // We use dynamic require to get a fresh module instance
      jest.isolateModules(() => {
        require('../../src/background/background');
      });
    });

    it('should complete full refresh flow with successful API responses', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      // Set up session cookie
      setSessionCookie('myorg.lightning.force.com', 'valid-session-123');
      setDefaultSettings();

      // Mock API success
      mockSalesforceApiSuccess(instanceUrl);

      // Send refresh message (simulating popup → background)
      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Verify success response
      expect(response.success).toBe(true);
      expect(response.timestamp).toBeDefined();
      expect(typeof response.timestamp).toBe('number');

      // Verify index was stored
      const storageKey = STORAGE_KEY_PREFIX + orgId;
      expect(mockLocalStorage[storageKey]).toBeDefined();

      const storedIndex = mockLocalStorage[storageKey] as OrgIndex;
      expect(storedIndex.orgId).toBe(orgId);
      expect(storedIndex.instanceUrl).toBe(instanceUrl);
      expect(storedIndex.entries.length).toBeGreaterThan(0);
      expect(storedIndex.version).toBe(1);
    });

    it('should return error when session cookie is missing', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      // No cookie set
      setDefaultSettings();

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Session expired');
    });

    it('should succeed with empty index when Salesforce API returns 401 (per-type partial failure)', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      setSessionCookie('myorg.lightning.force.com', 'expired-session');
      setDefaultSettings({ enabledTypes: ['Profile'] });
      mockSalesforceApiSessionExpired();

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // 401 per-type is caught as partial failure — buildIndex returns empty entries
      // The refresh technically "succeeds" but with no data
      expect(response.success).toBe(true);

      const storageKey = STORAGE_KEY_PREFIX + orgId;
      const storedIndex = mockLocalStorage[storageKey] as OrgIndex;
      expect(storedIndex.entries.length).toBe(0);
    });

    it('should handle partial API failures and still build partial index', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      setSessionCookie('myorg.lightning.force.com', 'valid-session-123');
      // Only enable Profile and Flow to simplify
      setDefaultSettings({ enabledTypes: ['Profile', 'Flow'] });
      mockSalesforceApiPartialFailure();

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Should succeed (partial failure is not a total failure)
      expect(response.success).toBe(true);

      // Verify index contains Profile entries but not Flow entries
      const storageKey = STORAGE_KEY_PREFIX + orgId;
      const storedIndex = mockLocalStorage[storageKey] as OrgIndex;
      expect(storedIndex.entries.some(e => e.type === 'Profile')).toBe(true);
      expect(storedIndex.entries.some(e => e.type === 'Flow')).toBe(false);
    });
  });

  describe('Multi-org index isolation', () => {
    beforeEach(async () => {
      jest.isolateModules(() => {
        require('../../src/background/background');
      });
    });

    it('should maintain separate indices for different orgs', async () => {
      const orgA = '00D000000000AAA';
      const orgB = '00D000000000BBB';
      const instanceUrlA = 'https://orga.lightning.force.com';
      const instanceUrlB = 'https://orgb.lightning.force.com';

      setDefaultSettings();
      mockSalesforceApiSuccess(instanceUrlA);

      // Set cookie for org A and refresh
      setSessionCookie('orga.lightning.force.com', 'session-a');
      await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId: orgA, instanceUrl: instanceUrlA },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Set cookie for org B and refresh
      setSessionCookie('orgb.lightning.force.com', 'session-b');
      await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId: orgB, instanceUrl: instanceUrlB },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Both indices should exist independently
      const indexA = mockLocalStorage[STORAGE_KEY_PREFIX + orgA] as OrgIndex;
      const indexB = mockLocalStorage[STORAGE_KEY_PREFIX + orgB] as OrgIndex;

      expect(indexA).toBeDefined();
      expect(indexB).toBeDefined();
      expect(indexA.orgId).toBe(orgA);
      expect(indexB.orgId).toBe(orgB);
      expect(indexA.instanceUrl).toBe(instanceUrlA);
      expect(indexB.instanceUrl).toBe(instanceUrlB);
    });
  });

  describe('Error propagation', () => {
    beforeEach(async () => {
      jest.isolateModules(() => {
        require('../../src/background/background');
      });
    });

    it('should handle rate limit errors gracefully (partial failure per type)', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      setSessionCookie('myorg.lightning.force.com', 'valid-session');
      setDefaultSettings({ enabledTypes: ['Profile'] });

      // Mock 429 response
      mockFetch.mockImplementation(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ message: 'Rate limit exceeded' }),
      }));

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Rate limit per-type is a partial failure — buildIndex catches it and continues
      // Result is success but with zero entries for the failed type
      expect(response.success).toBe(true);

      const storageKey = STORAGE_KEY_PREFIX + orgId;
      const storedIndex = mockLocalStorage[storageKey] as OrgIndex;
      expect(storedIndex.entries.length).toBe(0); // Profile failed, so no entries
    });

    it('should handle server errors gracefully (partial failure per type)', async () => {
      const orgId = '00D000000000001';
      const instanceUrl = 'https://myorg.lightning.force.com';

      setSessionCookie('myorg.lightning.force.com', 'valid-session');
      setDefaultSettings({ enabledTypes: ['Profile'] });

      // Mock 503 response
      mockFetch.mockImplementation(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ message: 'Service unavailable' }),
      }));

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'refreshIndex', orgId, instanceUrl },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      // Server error per-type is a partial failure — caught and continued
      expect(response.success).toBe(true);

      const storageKey = STORAGE_KEY_PREFIX + orgId;
      const storedIndex = mockLocalStorage[storageKey] as OrgIndex;
      expect(storedIndex.entries.length).toBe(0);
    });
  });

  describe('getSessionId message', () => {
    beforeEach(async () => {
      jest.isolateModules(() => {
        require('../../src/background/background');
      });
    });

    it('should return session ID when cookie exists', async () => {
      setSessionCookie('myorg.lightning.force.com', 'my-session-token');

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'getSessionId', domain: 'https://myorg.lightning.force.com' },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      expect(response.sessionId).toBe('my-session-token');
    });

    it('should return null when cookie does not exist', async () => {
      // No cookie set

      const response = await new Promise<any>((resolve) => {
        for (const listener of messageListeners) {
          const returned = listener(
            { action: 'getSessionId', domain: 'https://unknown.salesforce.com' },
            { tab: { id: 1 } } as chrome.runtime.MessageSender,
            resolve
          );
          if (returned === true) break;
        }
      });

      expect(response.sessionId).toBeNull();
    });
  });
});
