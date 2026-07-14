import { isSalesforceDomain } from '../../src/shared/domain-utils';

describe('isSalesforceDomain', () => {
  describe('valid Salesforce URLs', () => {
    it('returns true for *.salesforce.com', () => {
      expect(isSalesforceDomain('https://mycompany.salesforce.com/home')).toBe(true);
    });

    it('returns true for *.lightning.force.com', () => {
      expect(isSalesforceDomain('https://mycompany.lightning.force.com/setup')).toBe(true);
    });

    it('returns true for *.force.com', () => {
      expect(isSalesforceDomain('https://mycompany.my.force.com/page')).toBe(true);
    });

    it('returns true for deeply nested subdomains on salesforce.com', () => {
      expect(isSalesforceDomain('https://na1.my.salesforce.com/')).toBe(true);
    });

    it('returns true for deeply nested subdomains on force.com', () => {
      expect(isSalesforceDomain('https://sandbox.cs5.my.force.com/')).toBe(true);
    });

    it('returns true for URLs with paths and query strings', () => {
      expect(
        isSalesforceDomain('https://myorg.lightning.force.com/lightning/setup/Flows/home?q=test')
      ).toBe(true);
    });

    it('returns true for URLs with port numbers', () => {
      expect(isSalesforceDomain('https://myorg.salesforce.com:443/home')).toBe(true);
    });
  });

  describe('non-Salesforce URLs', () => {
    it('returns false for google.com', () => {
      expect(isSalesforceDomain('https://www.google.com')).toBe(false);
    });

    it('returns false for domains containing salesforce as a substring', () => {
      expect(isSalesforceDomain('https://notsalesforce.com')).toBe(false);
    });

    it('returns false for domains that contain force.com as substring', () => {
      expect(isSalesforceDomain('https://airforce.com/page')).toBe(false);
    });

    it('returns false for bare salesforce.com without subdomain', () => {
      expect(isSalesforceDomain('https://salesforce.com')).toBe(false);
    });

    it('returns false for bare force.com without subdomain', () => {
      expect(isSalesforceDomain('https://force.com')).toBe(false);
    });

    it('returns false for similar-looking domains', () => {
      expect(isSalesforceDomain('https://evil.salesforce.com.attacker.io/login')).toBe(false);
    });
  });

  describe('invalid/malformed URLs', () => {
    it('returns false for empty string', () => {
      expect(isSalesforceDomain('')).toBe(false);
    });

    it('returns false for random text', () => {
      expect(isSalesforceDomain('not a url at all')).toBe(false);
    });

    it('returns false for URL without protocol', () => {
      expect(isSalesforceDomain('mycompany.salesforce.com')).toBe(false);
    });

    it('returns false for HTTP (non-HTTPS) Salesforce URLs', () => {
      expect(isSalesforceDomain('http://mycompany.salesforce.com/home')).toBe(false);
    });

    it('returns false for null-like values passed as strings', () => {
      expect(isSalesforceDomain('null')).toBe(false);
      expect(isSalesforceDomain('undefined')).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('returns true for uppercase hostname', () => {
      expect(isSalesforceDomain('https://MYCOMPANY.SALESFORCE.COM/home')).toBe(true);
    });

    it('returns true for mixed case hostname', () => {
      expect(isSalesforceDomain('https://MyCompany.Lightning.Force.Com/setup')).toBe(true);
    });

    it('returns true for mixed case force.com', () => {
      expect(isSalesforceDomain('https://MyOrg.My.Force.COM/')).toBe(true);
    });
  });
});
