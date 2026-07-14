/**
 * SFDC Metadata Navigator - Content Script
 *
 * Runs on Salesforce pages (as configured in manifest.json content_scripts).
 * Extracts the org ID and instance URL from the active page, and responds
 * to messages from the background service worker requesting org info.
 */

import { BackgroundToContent, ContentToBackground } from '../shared/types';

/**
 * Attempts to extract the Salesforce org ID from the page using multiple strategies.
 *
 * Strategy 1: Parse the `auraConfig` element (Lightning Experience pages embed org context here)
 * Strategy 2: Read the `oid` cookie from `document.cookie`
 * Strategy 3: Parse from URL structure (some classic UI URLs contain org ID)
 *
 * @returns The 15-or-18 character org ID, or `null` if extraction fails
 */
export function extractOrgId(): string | null {
  // Strategy 1: Read from auraConfig element (Lightning Experience)
  const orgIdFromAura = extractOrgIdFromAuraConfig();
  if (orgIdFromAura) {
    return orgIdFromAura;
  }

  // Strategy 2: Read from 'oid' cookie
  const orgIdFromCookie = extractOrgIdFromCookie();
  if (orgIdFromCookie) {
    return orgIdFromCookie;
  }

  // Strategy 3: Read from page markup (scripts, meta tags)
  const orgIdFromMarkup = extractOrgIdFromMarkup();
  if (orgIdFromMarkup) {
    return orgIdFromMarkup;
  }

  // Strategy 4: Parse from URL structure
  const orgIdFromUrl = extractOrgIdFromUrl();
  if (orgIdFromUrl) {
    return orgIdFromUrl;
  }

  return null;
}

/**
 * Strategy 1: Extract org ID from the `auraConfig` element.
 * In Lightning Experience, Salesforce embeds a JSON config in a script tag
 * with id `auraConfig` that contains context about the current org.
 */
export function extractOrgIdFromAuraConfig(): string | null {
  try {
    const auraConfigEl = document.getElementById('auraConfig');
    if (!auraConfigEl) {
      return null;
    }

    const configText = auraConfigEl.textContent || auraConfigEl.innerHTML || '';
    if (!configText.trim()) {
      return null;
    }

    const config = JSON.parse(configText);

    // The org ID can appear in context.fwuid path or directly in the config
    if (config?.context?.global?.orgId) {
      return config.context.global.orgId;
    }

    // Alternative location: directly in config
    if (config?.orgId) {
      return config.orgId;
    }

    return null;
  } catch {
    // JSON parse failure or other error — fall through to next strategy
    return null;
  }
}

/**
 * Strategy 2: Extract org ID from the `oid` cookie.
 * Salesforce sets an `oid` cookie with the 15-character org ID on the domain.
 * Note: If the cookie is HttpOnly, this won't work (use background worker fallback).
 */
export function extractOrgIdFromCookie(): string | null {
  try {
    const cookies = document.cookie.split(';');
    const oidCookie = cookies.find((c) => c.trim().startsWith('oid='));
    if (oidCookie) {
      const value = oidCookie.split('=')[1]?.trim();
      if (value && isValidOrgId(value)) {
        return value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strategy 3: Extract org ID from page markup patterns.
 * Lightning Experience pages often embed the org ID in various DOM elements,
 * meta tags, or inline scripts.
 */
export function extractOrgIdFromMarkup(): string | null {
  try {
    // Check meta tags
    const metaOrg = document.querySelector('meta[name="org-id"]');
    if (metaOrg) {
      const value = metaOrg.getAttribute('content');
      if (value && isValidOrgId(value)) return value;
    }

    // Check for the org ID in script content (Lightning pages embed it in various scripts)
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const text = script.textContent || '';
      // Look for common patterns where org ID appears
      const patterns = [
        /\"orgId\"\s*:\s*\"(00D[a-zA-Z0-9]{12,15})\"/,
        /\"organizationId\"\s*:\s*\"(00D[a-zA-Z0-9]{12,15})\"/,
        /orgId\s*=\s*['\"](00D[a-zA-Z0-9]{12,15})['\"]/, 
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1] && isValidOrgId(match[1])) {
          return match[1];
        }
      }
    }

    // Check for the org ID in link elements (some SF pages include it in canonical/api links)
    const links = Array.from(document.querySelectorAll('link[href*="00D"]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(00D[a-zA-Z0-9]{12,15})/);
      if (match && match[1] && isValidOrgId(match[1])) {
        return match[1];
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Strategy 4: Extract org ID from the URL structure.
 * Some Salesforce URLs (particularly in Classic UI) contain the org ID in
 * specific path segments or query parameters.
 */
export function extractOrgIdFromUrl(): string | null {
  try {
    const url = window.location.href;

    // Check for org ID in the URL path (e.g., /servlet/servlet.OrgExport?setupid=DataManagementExport&oid=00D...)
    const oidParam = new URL(url).searchParams.get('oid');
    if (oidParam && isValidOrgId(oidParam)) {
      return oidParam;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validates that a string looks like a Salesforce org ID.
 * Org IDs are either 15 or 18 alphanumeric characters, starting with '00D'.
 */
export function isValidOrgId(value: string): boolean {
  return /^00D[a-zA-Z0-9]{12,15}$/.test(value);
}

/**
 * Extracts both the org ID and instance URL from the current page.
 *
 * @returns Object with `orgId` and `instanceUrl`, or `null` for orgId if extraction fails
 */
export function extractOrgInfo(): { orgId: string | null; instanceUrl: string } {
  const orgId = extractOrgId();
  const instanceUrl = window.location.origin;
  return { orgId, instanceUrl };
}

// ---------------------------------------------------------------------------
// Chrome Message Listener
// ---------------------------------------------------------------------------

/**
 * Listen for messages from the background service worker.
 * Responds to `getOrgInfo` action with the extracted org info.
 */
chrome.runtime.onMessage.addListener(
  (
    message: BackgroundToContent,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentToBackground) => void
  ) => {
    if (message.action === 'getOrgInfo') {
      const info = extractOrgInfo();

      if (info.orgId) {
        sendResponse({ orgId: info.orgId, instanceUrl: info.instanceUrl });
      } else {
        sendResponse({ error: 'Unable to extract org ID from the current page' });
      }
    }

    // Return true to indicate async response is not needed (response sent synchronously)
    return false;
  }
);
