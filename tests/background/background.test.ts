/**
 * Unit tests for the background service worker entry point.
 *
 * Verifies:
 * - refreshIndex success flow (cookie read → build → save → respond)
 * - refreshIndex failure when no session cookie
 * - refreshIndex failure categorization for each error type
 * - getSessionId responds with cookie value
 */

import { IndexEntry } from '../../src/shared/types';
import { SessionExpiredError, RateLimitError, ServerError, ApiTimeoutError } from '../../src/background/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock session module
const mockGetSessionCookie = jest.fn<Promise<string | null>, [string]>();
const mockGetSession = jest.fn();
jest.mock('../../src/background/session', () => ({
  getSessionCookie: (...args: [string]) => mockGetSessionCookie(...args),
  getSession: (...args: [string]) => mockGetSession(...args),
}));

// Mock index-builder module
const mockBuildIndex = jest.fn<Promise<IndexEntry[]>, [string, string, string[]]>();
jest.mock('../../src/background/index-builder', () => ({
  buildIndex: (...args: [string, string, string[]]) => mockBuildIndex(...args),
}));

// Mock storage module
const mockSaveOrgIndex = jest.fn<Promise<void>, [unknown]>();
jest.mock('../../src/background/storage', () => ({
  saveOrgIndex: (...args: [unknown]) => mockSaveOrgIndex(...args),
}));

// Mock scanner module
jest.mock('../../src/scanner/scanner', () => ({
  runOrgScan: jest.fn().mockResolvedValue({ results: [], totalClasses: 0, totalViolations: 0 }),
}));

// ---------------------------------------------------------------------------
// Chrome API Mocks
// ---------------------------------------------------------------------------

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean;

let messageListener: MessageListener;

const mockSyncGet = jest.fn();

beforeAll(() => {
  // Set up chrome global before importing the module
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          messageListener = listener;
        },
      },
    },
    storage: {
      sync: {
        get: mockSyncGet,
      },
      local: {
        set: jest.fn(),
        get: jest.fn(),
      },
    },
    cookies: {
      get: jest.fn(),
    },
  };

  // Default: return default settings
  mockSyncGet.mockResolvedValue({});
});

// Import the module AFTER setting up chrome mock — this triggers the addListener call
beforeAll(async () => {
  await import('../../src/background/background');
});

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const sender: chrome.runtime.MessageSender = {};
    messageListener(message, sender, resolve);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('background service worker', () => {
  beforeEach(() => {
    mockGetSessionCookie.mockReset();
    mockGetSession.mockReset();
    mockBuildIndex.mockReset();
    mockSaveOrgIndex.mockReset();
    mockSyncGet.mockReset();
    mockSyncGet.mockResolvedValue({});

    // Wire mockGetSession to delegate to mockGetSessionCookie behavior
    mockGetSession.mockImplementation(async () => {
      const sessionId = await mockGetSessionCookie('');
      if (!sessionId) return null;
      return { sessionId, hostname: 'myorg.my.salesforce.com' };
    });
  });

  describe('refreshIndex action', () => {
    const refreshMessage = {
      action: 'refreshIndex' as const,
      orgId: '00D000000000001',
      instanceUrl: 'https://myorg.lightning.force.com',
    };

    it('returns success with timestamp when refresh completes successfully', async () => {
      const mockEntries: IndexEntry[] = [
        {
          id: '01p000000000001',
          name: 'Admin',
          type: 'Profile',
          typeLabel: 'Profile',
          url: '/lightning/setup/EnhancedProfiles/page?address=/01p000000000001',
        },
      ];

      mockGetSessionCookie.mockResolvedValue('valid-session-id');
      mockBuildIndex.mockResolvedValue(mockEntries);
      mockSaveOrgIndex.mockResolvedValue(undefined);

      const response = await sendMessage(refreshMessage) as { success: boolean; timestamp?: number };

      expect(response.success).toBe(true);
      expect(response.timestamp).toBeDefined();
      expect(typeof response.timestamp).toBe('number');
    });

    it('reads session cookie using the provided instanceUrl', async () => {
      mockGetSessionCookie.mockResolvedValue('session-123');
      mockBuildIndex.mockResolvedValue([]);
      mockSaveOrgIndex.mockResolvedValue(undefined);

      await sendMessage(refreshMessage);

      expect(mockGetSession).toHaveBeenCalledWith('https://myorg.lightning.force.com');
    });

    it('calls buildIndex with the session ID and enabled types from settings', async () => {
      mockGetSessionCookie.mockResolvedValue('my-session');
      mockBuildIndex.mockResolvedValue([]);
      mockSaveOrgIndex.mockResolvedValue(undefined);
      mockSyncGet.mockResolvedValue({
        user_settings: {
          enabledTypes: ['Profile', 'Flow'],
          maxResults: 20,
          version: 1,
        },
      });

      await sendMessage(refreshMessage);

      expect(mockBuildIndex).toHaveBeenCalledWith(
        'https://myorg.my.salesforce.com',
        'my-session',
        ['Profile', 'Flow']
      );
    });

    it('uses default settings when sync storage returns nothing', async () => {
      mockGetSessionCookie.mockResolvedValue('session-xyz');
      mockBuildIndex.mockResolvedValue([]);
      mockSaveOrgIndex.mockResolvedValue(undefined);
      mockSyncGet.mockResolvedValue({});

      await sendMessage(refreshMessage);

      // Default settings include all 7 metadata types
      expect(mockBuildIndex).toHaveBeenCalledWith(
        'https://myorg.my.salesforce.com',
        'session-xyz',
        expect.arrayContaining(['Profile', 'PermissionSet', 'Flow', 'EmailTemplate', 'Layout', 'ValidationRule', 'ApexClass'])
      );
    });

    it('saves the built OrgIndex with correct structure', async () => {
      const mockEntries: IndexEntry[] = [
        {
          id: '300000000000001',
          name: 'My Flow',
          type: 'Flow',
          typeLabel: 'Flow',
          url: '/lightning/setup/Flows/page?address=/300000000000001',
        },
      ];

      mockGetSessionCookie.mockResolvedValue('session-abc');
      mockBuildIndex.mockResolvedValue(mockEntries);
      mockSaveOrgIndex.mockResolvedValue(undefined);

      await sendMessage(refreshMessage);

      expect(mockSaveOrgIndex).toHaveBeenCalledTimes(1);
      const savedIndex = mockSaveOrgIndex.mock.calls[0][0] as {
        orgId: string;
        instanceUrl: string;
        entries: IndexEntry[];
        lastRefreshed: number;
        version: number;
      };
      expect(savedIndex.orgId).toBe('00D000000000001');
      expect(savedIndex.instanceUrl).toBe('https://myorg.lightning.force.com');
      expect(savedIndex.entries).toEqual(mockEntries);
      expect(savedIndex.version).toBe(1);
      expect(typeof savedIndex.lastRefreshed).toBe('number');
    });

    it('returns failure when no session cookie is found', async () => {
      mockGetSessionCookie.mockResolvedValue(null);

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Session expired — please log in to Salesforce and try again');
      expect(mockBuildIndex).not.toHaveBeenCalled();
      expect(mockSaveOrgIndex).not.toHaveBeenCalled();
    });

    it('categorizes SessionExpiredError correctly', async () => {
      mockGetSessionCookie.mockResolvedValue('session-will-expire');
      mockBuildIndex.mockRejectedValue(new SessionExpiredError());

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Session expired — please log in to Salesforce and try again');
    });

    it('categorizes RateLimitError correctly', async () => {
      mockGetSessionCookie.mockResolvedValue('valid-session');
      mockBuildIndex.mockRejectedValue(new RateLimitError());

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Salesforce API limit reached — try again later');
    });

    it('categorizes ServerError correctly', async () => {
      mockGetSessionCookie.mockResolvedValue('valid-session');
      mockBuildIndex.mockRejectedValue(new ServerError(503));

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Salesforce server error — try again later');
    });

    it('categorizes ApiTimeoutError correctly', async () => {
      mockGetSessionCookie.mockResolvedValue('valid-session');
      mockBuildIndex.mockRejectedValue(new ApiTimeoutError());

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Request timed out — check your connection');
    });

    it('categorizes storage quota errors correctly', async () => {
      mockGetSessionCookie.mockResolvedValue('valid-session');
      mockBuildIndex.mockResolvedValue([]);
      mockSaveOrgIndex.mockRejectedValue(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Storage full — try reducing indexed metadata types');
    });

    it('returns generic error message for unknown errors', async () => {
      mockGetSessionCookie.mockResolvedValue('valid-session');
      mockBuildIndex.mockRejectedValue(new Error('Something completely unexpected'));

      const response = await sendMessage(refreshMessage) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toBe('An unexpected error occurred');
    });
  });

  describe('getSessionId action', () => {
    it('responds with session cookie value when cookie exists', async () => {
      mockGetSessionCookie.mockResolvedValue('session-id-from-cookie');

      const response = await sendMessage({
        action: 'getSessionId',
        domain: 'https://myorg.my.salesforce.com',
      }) as { sessionId: string | null };

      expect(response.sessionId).toBe('session-id-from-cookie');
      expect(mockGetSessionCookie).toHaveBeenCalledWith('https://myorg.my.salesforce.com');
    });

    it('responds with null when no cookie exists', async () => {
      mockGetSessionCookie.mockResolvedValue(null);

      const response = await sendMessage({
        action: 'getSessionId',
        domain: 'https://noauth.lightning.force.com',
      }) as { sessionId: string | null };

      expect(response.sessionId).toBeNull();
    });

    it('responds with null when getSessionCookie throws', async () => {
      mockGetSessionCookie.mockRejectedValue(new Error('Cookies API failed'));

      const response = await sendMessage({
        action: 'getSessionId',
        domain: 'https://error.force.com',
      }) as { sessionId: string | null };

      expect(response.sessionId).toBeNull();
    });
  });

  describe('unknown action', () => {
    it('returns false for unrecognized message actions', () => {
      const sender: chrome.runtime.MessageSender = {};
      const sendResponse = jest.fn();

      const result = messageListener(
        { action: 'unknownAction' },
        sender,
        sendResponse
      );

      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });
});
