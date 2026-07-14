/**
 * SFDC Metadata Navigator - Session Cookie Reader
 *
 * Reads the Salesforce session cookie (sid) from the browser using
 * the Chrome cookies API. This piggy-backs on the user's existing
 * authenticated session rather than requiring a separate OAuth flow.
 *
 * Follows the same approach as Salesforce Inspector Reloaded:
 * - The sid cookie value format is: orgId!restOfSessionToken
 * - The session on *.lightning.force.com may not have API access
 * - We need to find the matching session on *.salesforce.com (or similar)
 *   that has API access, using the org ID as the correlation key.
 */

/**
 * Domains where Salesforce stores API-accessible session cookies.
 * Checked in order of likelihood.
 */
const API_COOKIE_DOMAINS = [
  'salesforce.com',
  'cloudforce.com',
  'salesforce.mil',
  'cloudforce.mil',
  'sfcrmproducts.cn',
];

/**
 * Result of session discovery: the session token and the API-capable hostname.
 */
export interface SessionInfo {
  /** The full sid cookie value (used as Bearer token) */
  sessionId: string;
  /** The hostname where API calls should be directed (e.g., "myorg.my.salesforce.com") */
  hostname: string;
}

/**
 * Finds the API-accessible Salesforce session for the given URL.
 *
 * Strategy:
 * 1. Read the sid cookie from the given URL to get the org ID
 * 2. Search across known Salesforce API domains for a session cookie
 *    with the same org ID prefix
 * 3. Return the matching session token and hostname
 *
 * @param instanceUrl - The full URL of the Salesforce instance (e.g., 'https://mycompany.lightning.force.com')
 * @returns SessionInfo with the session token and API hostname, or null if not found
 */
export async function getSession(instanceUrl: string): Promise<SessionInfo | null> {
  try {
    // Step 1: Read the sid cookie from the current page URL to get the org ID
    const pageCookie = await chrome.cookies.get({ url: instanceUrl, name: 'sid' });
    if (!pageCookie?.value) {
      return null;
    }

    // Check if cookie is expired (defensive — Chrome usually removes expired cookies)
    if (pageCookie.expirationDate !== undefined) {
      const nowInSeconds = Date.now() / 1000;
      if (pageCookie.expirationDate < nowInSeconds) {
        return null;
      }
    }

    const [orgId] = pageCookie.value.split('!');
    if (!orgId) {
      return null;
    }

    // Step 2: Try the page cookie first — it might have API access
    // (This works for *.my.salesforce.com pages)
    if (pageCookie.domain.includes('salesforce.com') || pageCookie.domain.includes('cloudforce.com')) {
      return {
        sessionId: pageCookie.value,
        hostname: pageCookie.domain.startsWith('.') ? pageCookie.domain.substring(1) : pageCookie.domain,
      };
    }

    // Step 3: Search known API domains for a matching session
    for (const domain of API_COOKIE_DOMAINS) {
      try {
        const cookies = await chrome.cookies.getAll({ name: 'sid', domain, secure: true });
        const match = cookies.find(
          c => c.value.startsWith(orgId + '!') && !c.domain.includes('help.salesforce.com')
        );
        if (match) {
          const hostname = match.domain.startsWith('.') ? match.domain.substring(1) : match.domain;
          return {
            sessionId: match.value,
            hostname,
          };
        }
      } catch { /* ignore, try next domain */ }
    }

    // Step 4: Fall back to using the page cookie as-is
    // (Might work for some org configurations)
    return {
      sessionId: pageCookie.value,
      hostname: new URL(instanceUrl).hostname,
    };
  } catch {
    return null;
  }
}

/**
 * Legacy wrapper: Reads the session cookie value for the given domain.
 * Kept for backward compatibility.
 *
 * @param domain - The full URL of the Salesforce instance
 * @returns The session ID string if found, or null
 */
export async function getSessionCookie(domain: string): Promise<string | null> {
  const session = await getSession(domain);
  return session?.sessionId ?? null;
}
