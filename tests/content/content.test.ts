/**
 * Unit tests for the Content Script org info extraction.
 *
 * Tests cover:
 * - Org ID extraction from oid cookie (Strategy 2)
 * - Org ID extraction from auraConfig element (Strategy 1)
 * - Org ID extraction from URL (Strategy 3)
 * - Fallback behavior when all strategies fail
 * - isValidOrgId validation
 * - extractOrgInfo combining orgId + instanceUrl
 * - Chrome message listener responding correctly
 */

// Set up chrome mock before module import
const mockAddListener = jest.fn();
(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    onMessage: {
      addListener: mockAddListener,
    },
  },
};

// Set up window.location mock
Object.defineProperty(globalThis, 'window', {
  value: {
    location: {
      origin: 'https://mycompany.lightning.force.com',
      href: 'https://mycompany.lightning.force.com/lightning/setup/home',
    },
  },
  writable: true,
});

// Set up document mock
const mockGetElementById = jest.fn();
Object.defineProperty(globalThis, 'document', {
  value: {
    getElementById: mockGetElementById,
    cookie: '',
  },
  writable: true,
});

import {
  extractOrgId,
  extractOrgIdFromAuraConfig,
  extractOrgIdFromCookie,
  extractOrgIdFromUrl,
  extractOrgInfo,
  isValidOrgId,
} from '../../src/content/content';

describe('Content Script - isValidOrgId', () => {
  it('should return true for valid 15-char org ID', () => {
    expect(isValidOrgId('00D000000000001')).toBe(true);
  });

  it('should return true for valid 18-char org ID', () => {
    expect(isValidOrgId('00D000000000001AAA')).toBe(true);
  });

  it('should return false for IDs not starting with 00D', () => {
    expect(isValidOrgId('001000000000001')).toBe(false);
    expect(isValidOrgId('00A000000000001')).toBe(false);
  });

  it('should return false for IDs that are too short', () => {
    expect(isValidOrgId('00D0000')).toBe(false);
  });

  it('should return false for IDs that are too long', () => {
    expect(isValidOrgId('00D0000000000001234567')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isValidOrgId('')).toBe(false);
  });

  it('should return false for IDs with special characters', () => {
    expect(isValidOrgId('00D00000000-001')).toBe(false);
  });
});

describe('Content Script - extractOrgIdFromCookie', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'cookie', { value: '', writable: true });
  });

  it('should extract org ID from oid cookie', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'sid=abc123; oid=00Dbf000005DYozEAG; other=value',
      writable: true,
    });
    expect(extractOrgIdFromCookie()).toBe('00Dbf000005DYozEAG');
  });

  it('should extract org ID when oid is the first cookie', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'oid=00D000000000001; sid=abc123',
      writable: true,
    });
    expect(extractOrgIdFromCookie()).toBe('00D000000000001');
  });

  it('should return null when oid cookie is not present', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'sid=abc123; other=value',
      writable: true,
    });
    expect(extractOrgIdFromCookie()).toBeNull();
  });

  it('should return null when oid cookie has invalid org ID', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'oid=invalidvalue',
      writable: true,
    });
    expect(extractOrgIdFromCookie()).toBeNull();
  });

  it('should return null when cookie string is empty', () => {
    Object.defineProperty(document, 'cookie', { value: '', writable: true });
    expect(extractOrgIdFromCookie()).toBeNull();
  });
});

describe('Content Script - extractOrgIdFromAuraConfig', () => {
  beforeEach(() => {
    mockGetElementById.mockReset();
  });

  it('should extract org ID from auraConfig context.global.orgId', () => {
    const mockElement = {
      textContent: JSON.stringify({
        context: {
          global: {
            orgId: '00Dbf000005DYozEAG',
          },
        },
      }),
      innerHTML: '',
    };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBe('00Dbf000005DYozEAG');
  });

  it('should extract org ID from auraConfig top-level orgId', () => {
    const mockElement = {
      textContent: JSON.stringify({
        orgId: '00D000000000001',
      }),
      innerHTML: '',
    };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBe('00D000000000001');
  });

  it('should return null when auraConfig element does not exist', () => {
    mockGetElementById.mockReturnValue(null);

    expect(extractOrgIdFromAuraConfig()).toBeNull();
  });

  it('should return null when auraConfig has empty content', () => {
    const mockElement = { textContent: '', innerHTML: '' };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBeNull();
  });

  it('should return null when auraConfig has invalid JSON', () => {
    const mockElement = { textContent: 'not valid json {{{', innerHTML: '' };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBeNull();
  });

  it('should return null when auraConfig JSON lacks orgId fields', () => {
    const mockElement = {
      textContent: JSON.stringify({ someOtherField: 'value' }),
      innerHTML: '',
    };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBeNull();
  });

  it('should prefer context.global.orgId over top-level orgId', () => {
    const mockElement = {
      textContent: JSON.stringify({
        orgId: '00D000000000002',
        context: {
          global: {
            orgId: '00D000000000001',
          },
        },
      }),
      innerHTML: '',
    };
    mockGetElementById.mockReturnValue(mockElement);

    expect(extractOrgIdFromAuraConfig()).toBe('00D000000000001');
  });
});

describe('Content Script - extractOrgIdFromUrl', () => {
  it('should extract org ID from oid query parameter', () => {
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/servlet/servlet.OrgExport?setupid=DataManagementExport&oid=00D000000000001',
      },
      writable: true,
    });

    expect(extractOrgIdFromUrl()).toBe('00D000000000001');
  });

  it('should return null when URL has no oid parameter', () => {
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/lightning/setup/home',
      },
      writable: true,
    });

    expect(extractOrgIdFromUrl()).toBeNull();
  });

  it('should return null when oid parameter has invalid value', () => {
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/page?oid=invalidvalue',
      },
      writable: true,
    });

    expect(extractOrgIdFromUrl()).toBeNull();
  });
});

describe('Content Script - extractOrgId (combined strategies)', () => {
  beforeEach(() => {
    mockGetElementById.mockReset();
    Object.defineProperty(document, 'cookie', { value: '', writable: true });
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/lightning/setup/home',
      },
      writable: true,
    });
  });

  it('should return org ID from auraConfig first (Strategy 1 priority)', () => {
    const mockElement = {
      textContent: JSON.stringify({ context: { global: { orgId: '00DauraConfig001' } } }),
      innerHTML: '',
    };
    mockGetElementById.mockReturnValue(mockElement);
    Object.defineProperty(document, 'cookie', {
      value: 'oid=00Dcookieval001',
      writable: true,
    });

    expect(extractOrgId()).toBe('00DauraConfig001');
  });

  it('should fall back to cookie when auraConfig is unavailable', () => {
    mockGetElementById.mockReturnValue(null);
    Object.defineProperty(document, 'cookie', {
      value: 'oid=00Dcookieval001',
      writable: true,
    });

    expect(extractOrgId()).toBe('00Dcookieval001');
  });

  it('should return null when all strategies fail', () => {
    mockGetElementById.mockReturnValue(null);
    Object.defineProperty(document, 'cookie', { value: '', writable: true });

    expect(extractOrgId()).toBeNull();
  });
});

describe('Content Script - extractOrgInfo', () => {
  beforeEach(() => {
    mockGetElementById.mockReset();
    Object.defineProperty(document, 'cookie', { value: '', writable: true });
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/lightning/setup/home',
      },
      writable: true,
    });
  });

  it('should return orgId and instanceUrl on success', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'oid=00D000000000001',
      writable: true,
    });

    const result = extractOrgInfo();
    expect(result.orgId).toBe('00D000000000001');
    expect(result.instanceUrl).toBe('https://mycompany.lightning.force.com');
  });

  it('should return null orgId and instanceUrl on failure', () => {
    mockGetElementById.mockReturnValue(null);

    const result = extractOrgInfo();
    expect(result.orgId).toBeNull();
    expect(result.instanceUrl).toBe('https://mycompany.lightning.force.com');
  });
});

describe('Content Script - Chrome message listener', () => {
  let messageHandler: (
    message: { action: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => boolean | void;

  beforeEach(() => {
    // The listener was registered during module import
    messageHandler = mockAddListener.mock.calls[0][0];

    mockGetElementById.mockReset();
    Object.defineProperty(document, 'cookie', { value: '', writable: true });
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://mycompany.lightning.force.com',
        href: 'https://mycompany.lightning.force.com/lightning/setup/home',
      },
      writable: true,
    });
  });

  it('should respond with orgId and instanceUrl for getOrgInfo action', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'oid=00D000000000001',
      writable: true,
    });

    const sendResponse = jest.fn();
    messageHandler({ action: 'getOrgInfo' }, {} as chrome.runtime.MessageSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      orgId: '00D000000000001',
      instanceUrl: 'https://mycompany.lightning.force.com',
    });
  });

  it('should respond with error when org ID cannot be extracted', () => {
    mockGetElementById.mockReturnValue(null);
    Object.defineProperty(document, 'cookie', { value: '', writable: true });

    const sendResponse = jest.fn();
    messageHandler({ action: 'getOrgInfo' }, {} as chrome.runtime.MessageSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      error: 'Unable to extract org ID from the current page',
    });
  });

  it('should register exactly one message listener', () => {
    expect(mockAddListener).toHaveBeenCalledTimes(1);
  });
});
