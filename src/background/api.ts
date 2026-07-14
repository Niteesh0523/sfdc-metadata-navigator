/**
 * SFDC Metadata Navigator - Salesforce API Query Module
 *
 * Provides functions to query the Salesforce REST API and Tooling API,
 * handling pagination, timeouts, and error categorization.
 */

import { SalesforceQueryResponse, SalesforceRecord } from '../shared/types';
import { API_TIMEOUT, MAX_PAGINATION_HOPS } from '../shared/constants';

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the Salesforce session has expired (HTTP 401).
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired — please log in to Salesforce and try again') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when the Salesforce API rate limit is exceeded (HTTP 429).
 */
export class RateLimitError extends Error {
  constructor(message = 'Salesforce API limit reached — try again later') {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Thrown when the Salesforce API returns a server error (5xx).
 */
export class ServerError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message?: string) {
    super(message || `Salesforce server error (HTTP ${statusCode})`);
    this.name = 'ServerError';
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when an API request times out.
 */
export class ApiTimeoutError extends Error {
  constructor(message = 'API request timed out') {
    super(message);
    this.name = 'ApiTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Internal Helper
// ---------------------------------------------------------------------------

/**
 * Executes a single API request with timeout and error handling.
 *
 * @param url - Full URL to query (including query params)
 * @param sessionId - Salesforce session ID for authentication
 * @returns Parsed SalesforceQueryResponse
 * @throws SessionExpiredError, RateLimitError, ServerError, ApiTimeoutError
 */
export async function executeQuery(
  url: string,
  sessionId: string
): Promise<SalesforceQueryResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${sessionId}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new SessionExpiredError();
      }
      if (response.status === 429) {
        throw new RateLimitError();
      }
      if (response.status >= 500) {
        throw new ServerError(response.status);
      }
      throw new Error(`Salesforce API error (HTTP ${response.status})`);
    }

    const data: SalesforceQueryResponse = await response.json();
    return data;
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError ||
        error instanceof RateLimitError ||
        error instanceof ServerError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Queries the Salesforce REST API with pagination support.
 *
 * @param instanceUrl - The Salesforce instance URL (e.g., 'https://mycompany.lightning.force.com')
 * @param sessionId - Salesforce session ID for authentication
 * @param soql - SOQL query to execute
 * @returns Array of all records (accumulated across paginated responses)
 */
export async function queryRestApi(
  instanceUrl: string,
  sessionId: string,
  soql: string
): Promise<SalesforceRecord[]> {
  const initialUrl = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  return fetchAllRecords(initialUrl, instanceUrl, sessionId);
}

/**
 * Queries the Salesforce Tooling API with pagination support.
 *
 * @param instanceUrl - The Salesforce instance URL (e.g., 'https://mycompany.lightning.force.com')
 * @param sessionId - Salesforce session ID for authentication
 * @param soql - SOQL query to execute
 * @returns Array of all records (accumulated across paginated responses)
 */
export async function queryToolingApi(
  instanceUrl: string,
  sessionId: string,
  soql: string
): Promise<SalesforceRecord[]> {
  const initialUrl = `${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql)}`;
  return fetchAllRecords(initialUrl, instanceUrl, sessionId);
}

// ---------------------------------------------------------------------------
// Pagination Helper
// ---------------------------------------------------------------------------

/**
 * Fetches all records by following pagination links up to MAX_PAGINATION_HOPS.
 *
 * @param initialUrl - The first URL to fetch
 * @param instanceUrl - Base instance URL for resolving relative nextRecordsUrl
 * @param sessionId - Salesforce session ID
 * @returns Accumulated records from all pages
 */
async function fetchAllRecords(
  initialUrl: string,
  instanceUrl: string,
  sessionId: string
): Promise<SalesforceRecord[]> {
  const allRecords: SalesforceRecord[] = [];
  let currentUrl: string | undefined = initialUrl;
  let hops = 0;

  while (currentUrl && hops < MAX_PAGINATION_HOPS) {
    const response = await executeQuery(currentUrl, sessionId);
    allRecords.push(...response.records);

    if (response.done || !response.nextRecordsUrl) {
      break;
    }

    // nextRecordsUrl is a relative path — resolve against instance URL
    currentUrl = `${instanceUrl}${response.nextRecordsUrl}`;
    hops++;
  }

  return allRecords;
}
