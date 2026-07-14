/**
 * SFDC Metadata Navigator - Scanner Orchestrator
 *
 * Fetches Apex class source code bodies from the Salesforce Tooling API
 * and runs the rule-based analysis engine against each class.
 * Designed to run in the background service worker.
 */

import { SalesforceRecord } from '../shared/types';
import { analyzeApexClass, ScanResult } from './rules';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanProgress {
  /** Total number of classes to scan */
  total: number;
  /** Number of classes scanned so far */
  completed: number;
  /** Name of the class currently being scanned */
  currentClass: string;
  /** Whether the scan is complete */
  done: boolean;
}

export interface OrgScanResult {
  /** Org ID this scan belongs to */
  orgId: string;
  /** Timestamp when the scan completed */
  timestamp: number;
  /** Total classes scanned */
  totalClasses: number;
  /** Classes with at least one violation */
  classesWithIssues: number;
  /** Total violations found */
  totalViolations: number;
  /** Per-class scan results (only classes with violations) */
  results: ScanResult[];
  /** Summary counts by severity */
  summary: {
    critical: number;
    warning: number;
    info: number;
  };
  /** Summary counts by category */
  categories: {
    bulkification: number;
    performance: number;
    security: number;
    'best-practice': number;
    maintainability: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tooling API query to fetch Apex class bodies (excluding managed packages) */
const APEX_BODY_QUERY = "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name";

/** Tooling API query to fetch Apex trigger bodies */
const TRIGGER_BODY_QUERY = "SELECT Id, Name, Body FROM ApexTrigger WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name";

/** Maximum number of records per Tooling API query page */
const PAGE_SIZE = 200;

/** Maximum API pagination hops */
const MAX_PAGES = 25;

/** API request timeout (ms) */
const REQUEST_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// API Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches all Apex class records (with Body) from the Tooling API.
 * Handles pagination automatically.
 */
async function fetchApexBodies(
  apiHost: string,
  sessionId: string,
  query: string
): Promise<SalesforceRecord[]> {
  const allRecords: SalesforceRecord[] = [];
  let url: string | null = `https://${apiHost}/services/data/v59.0/tooling/query?q=${encodeURIComponent(query)}`;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sessionId}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Session expired — please log in to Salesforce and try again');
        }
        throw new Error(`API error (HTTP ${response.status})`);
      }

      const data = await response.json();
      allRecords.push(...(data.records || []));

      if (data.done || !data.nextRecordsUrl) {
        break;
      }

      url = `https://${apiHost}${data.nextRecordsUrl}`;
      pages++;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    }
  }

  return allRecords;
}

// ---------------------------------------------------------------------------
// Scanner Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs a full org scan: fetches all Apex classes and triggers, then
 * analyzes each one with the rule engine.
 *
 * @param apiHost - The API-accessible Salesforce hostname (e.g., "myorg.my.salesforce.com")
 * @param sessionId - The session token for authentication
 * @param orgId - The org ID for storage/identification
 * @param onProgress - Optional callback for reporting scan progress
 * @returns Complete scan results for the org
 */
export async function runOrgScan(
  apiHost: string,
  sessionId: string,
  orgId: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<OrgScanResult> {
  // Fetch all Apex class bodies
  const classes = await fetchApexBodies(apiHost, sessionId, APEX_BODY_QUERY);

  // Fetch all trigger bodies
  let triggers: SalesforceRecord[] = [];
  try {
    triggers = await fetchApexBodies(apiHost, sessionId, TRIGGER_BODY_QUERY);
  } catch {
    // Triggers might fail on some orgs — continue with classes only
  }

  const allItems = [...classes, ...triggers];
  const total = allItems.length;
  const results: ScanResult[] = [];

  // Analyze each class/trigger
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const name = item.Name as string;
    const body = item.Body as string;
    const id = item.Id;

    // Report progress
    if (onProgress) {
      onProgress({
        total,
        completed: i,
        currentClass: name,
        done: false,
      });
    }

    // Skip items without a body (shouldn't happen, but defensive)
    if (!body) continue;

    // Run analysis
    const result = analyzeApexClass(body, name, id);

    // Only include classes that have violations
    if (result.violations.length > 0) {
      results.push(result);
    }
  }

  // Report completion
  if (onProgress) {
    onProgress({
      total,
      completed: total,
      currentClass: '',
      done: true,
    });
  }

  // Build summary
  const summary = { critical: 0, warning: 0, info: 0 };
  const categories = {
    bulkification: 0,
    performance: 0,
    security: 0,
    'best-practice': 0,
    maintainability: 0,
  };

  let totalViolations = 0;
  for (const result of results) {
    for (const v of result.violations) {
      totalViolations++;
      summary[v.severity]++;
      categories[v.category]++;
    }
  }

  return {
    orgId,
    timestamp: Date.now(),
    totalClasses: total,
    classesWithIssues: results.length,
    totalViolations,
    results,
    summary,
    categories,
  };
}
