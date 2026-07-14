/**
 * SFDC Metadata Navigator - Domain detection utilities
 *
 * Provides functions to determine whether a given URL belongs to
 * a Salesforce domain, used by both the content script and popup
 * to gate extension behavior.
 */

/**
 * Recognized Salesforce domain suffixes (lowercase).
 * Order matters: more specific patterns are checked first.
 */
const SALESFORCE_DOMAIN_SUFFIXES = [
  '.lightning.force.com',
  '.force.com',
  '.salesforce.com',
  '.salesforce-setup.com',
] as const;

/**
 * Determines whether the given URL string belongs to a Salesforce domain.
 *
 * A URL is considered a Salesforce domain when:
 * 1. It is a valid, parseable URL
 * 2. It uses the HTTPS protocol
 * 3. Its hostname ends with one of the recognized Salesforce suffixes
 *
 * Matching is case-insensitive on the hostname.
 *
 * @param url - The URL string to check
 * @returns `true` if the URL is on a recognized Salesforce domain, `false` otherwise
 */
export function isSalesforceDomain(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only HTTPS URLs are valid Salesforce domains
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check against each recognized suffix
    return SALESFORCE_DOMAIN_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length
    );
  } catch {
    // Invalid or malformed URL
    return false;
  }
}
