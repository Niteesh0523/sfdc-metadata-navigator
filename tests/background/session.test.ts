// Mock the chrome.cookies API
const mockCookiesGet = jest.fn();

(globalThis as Record<string, unknown>).chrome = {
  cookies: {
    get: mockCookiesGet,
  },
};

import { getSessionCookie } from '../../src/background/session';

afterEach(() => {
  mockCookiesGet.mockReset();
});

describe('getSessionCookie', () => {
  const testDomain = 'https://mycompany.lightning.force.com';

  describe('successfully reading a valid session cookie', () => {
    it('returns the cookie value when a valid sid cookie exists', async () => {
      const futureExpiry = (Date.now() / 1000) + 3600; // 1 hour from now
      mockCookiesGet.mockResolvedValue({
        name: 'sid',
        value: '00Dxx0000001gEr!ARcAQH8z.example.session.id',
        domain: '.force.com',
        expirationDate: futureExpiry,
      });

      const result = await getSessionCookie(testDomain);

      expect(result).toBe('00Dxx0000001gEr!ARcAQH8z.example.session.id');
      expect(mockCookiesGet).toHaveBeenCalledWith({ url: testDomain, name: 'sid' });
    });

    it('returns the cookie value when expirationDate is not set (session cookie)', async () => {
      mockCookiesGet.mockResolvedValue({
        name: 'sid',
        value: 'session-cookie-value-without-expiry',
        domain: '.salesforce.com',
      });

      const result = await getSessionCookie(testDomain);

      expect(result).toBe('session-cookie-value-without-expiry');
    });
  });

  describe('returning null when cookie is not found', () => {
    it('returns null when chrome.cookies.get returns null', async () => {
      mockCookiesGet.mockResolvedValue(null);

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });

    it('returns null when chrome.cookies.get returns undefined', async () => {
      mockCookiesGet.mockResolvedValue(undefined);

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });
  });

  describe('returning null when chrome.cookies.get throws/rejects', () => {
    it('returns null when the API throws an error', async () => {
      mockCookiesGet.mockRejectedValue(new Error('Permission denied'));

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });

    it('returns null when the API throws a non-Error object', async () => {
      mockCookiesGet.mockRejectedValue('unexpected string error');

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });
  });

  describe('handling edge cases', () => {
    it('returns null when cookie value is an empty string', async () => {
      mockCookiesGet.mockResolvedValue({
        name: 'sid',
        value: '',
        domain: '.force.com',
        expirationDate: (Date.now() / 1000) + 3600,
      });

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });

    it('returns null when cookie is expired', async () => {
      const pastExpiry = (Date.now() / 1000) - 3600; // 1 hour ago
      mockCookiesGet.mockResolvedValue({
        name: 'sid',
        value: 'expired-session-value',
        domain: '.force.com',
        expirationDate: pastExpiry,
      });

      const result = await getSessionCookie(testDomain);

      expect(result).toBeNull();
    });

    it('passes the domain parameter correctly to chrome.cookies.get', async () => {
      const customDomain = 'https://custom-org.my.salesforce.com';
      mockCookiesGet.mockResolvedValue(null);

      await getSessionCookie(customDomain);

      expect(mockCookiesGet).toHaveBeenCalledWith({ url: customDomain, name: 'sid' });
    });
  });
});
