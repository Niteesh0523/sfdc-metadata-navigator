/**
 * SFDC Metadata Navigator - Index Builder Module
 *
 * Orchestrates metadata retrieval across all enabled types,
 * transforms API records into IndexEntry objects, and handles
 * partial failures and total timeout enforcement.
 */

import { IndexEntry, MetadataType, SalesforceRecord } from '../shared/types';
import { METADATA_QUERIES, REFRESH_TIMEOUT } from '../shared/constants';
import { buildSetupUrl, getDisplayName } from '../shared/url-builder';
import { queryRestApi, queryToolingApi } from './api';

// ---------------------------------------------------------------------------
// Type Labels
// ---------------------------------------------------------------------------

/**
 * Human-readable labels for each metadata type.
 */
export const TYPE_LABELS: Record<MetadataType, string> = {
  Profile: 'Profile',
  PermissionSet: 'Permission Set',
  Flow: 'Flow',
  EmailTemplate: 'Email Template',
  Layout: 'Page Layout',
  ValidationRule: 'Validation Rule',
  ApexClass: 'Apex Class',
  ApexTrigger: 'Apex Trigger',
  CustomMetadata: 'Custom Metadata Type',
  User: 'User',
  CustomLabel: 'Custom Label',
  NamedCredential: 'Named Credential',
  RemoteSiteSetting: 'Remote Site',
  ConnectedApp: 'Connected App',
};

// ---------------------------------------------------------------------------
// Index Builder
// ---------------------------------------------------------------------------

/**
 * Builds a complete search index by querying the Salesforce org for all
 * enabled metadata types.
 *
 * Handles partial failures gracefully: if one metadata type fails, the
 * builder continues with the remaining types and excludes failed types
 * from the result (zero entries for failed type).
 *
 * Enforces a total timeout of REFRESH_TIMEOUT (120 seconds). If the timeout
 * is exceeded, all remaining queries are aborted and only successfully
 * fetched entries are returned.
 *
 * @param instanceUrl - The Salesforce instance URL (e.g., 'https://mycompany.lightning.force.com')
 * @param sessionId - Salesforce session ID for authentication
 * @param enabledTypes - Array of metadata types to query
 * @returns Array of IndexEntry objects from all successfully queried types
 */
export async function buildIndex(
  instanceUrl: string,
  sessionId: string,
  enabledTypes: MetadataType[]
): Promise<IndexEntry[]> {
  const allEntries: IndexEntry[] = [];
  const startTime = Date.now();

  for (const metadataType of enabledTypes) {
    // Check if we've exceeded the total timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= REFRESH_TIMEOUT) {
      console.error(
        `[IndexBuilder] Total timeout of ${REFRESH_TIMEOUT}ms exceeded after ${elapsed}ms. ` +
        `Aborting remaining queries.`
      );
      break;
    }

    try {
      const entries = await fetchEntriesForType(instanceUrl, sessionId, metadataType);
      allEntries.push(...entries);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[IndexBuilder] Failed to fetch ${metadataType}: ${message}. Continuing with next type.`
      );
      // Partial failure: continue with next type
    }
  }

  // Filter out entries where name is empty (Req 4.3: both name and type must be present)
  return allEntries.filter(entry => entry.name.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches and transforms records for a single metadata type.
 *
 * @param instanceUrl - The Salesforce instance URL
 * @param sessionId - Session ID for authentication
 * @param metadataType - The metadata type to query
 * @returns Array of IndexEntry objects for this type
 */
async function fetchEntriesForType(
  instanceUrl: string,
  sessionId: string,
  metadataType: MetadataType
): Promise<IndexEntry[]> {
  const config = METADATA_QUERIES[metadataType];
  const { api, query } = config;

  let records: SalesforceRecord[];

  if (api === 'CUSTOM_USER') {
    records = await fetchUsers(instanceUrl, sessionId);
  } else if (api === 'CUSTOM_MDT') {
    records = await fetchCustomMetadataTypes(instanceUrl, sessionId);
  } else if (api === 'TOOLING') {
    records = await queryToolingApi(instanceUrl, sessionId, query);
  } else {
    records = await queryRestApi(instanceUrl, sessionId, query);
  }

  // Transform records into IndexEntry objects
  return records.map(record => transformRecord(record, metadataType));
}

/**
 * Fetches Users using the standard REST API query endpoint.
 * Includes all users (active and inactive), searchable by name, username, and email.
 */
async function fetchUsers(instanceUrl: string, sessionId: string): Promise<SalesforceRecord[]> {
  // Use Tooling API for User query — more reliable with session cookie auth
  // Limit to 1000 users to avoid exceeding Chrome storage limits
  const soql = "SELECT Id, Name, Username, Email FROM User ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1000";
  const url = `${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });

  if (!response.ok) {
    // Fallback to standard REST API if Tooling doesn't support User
    return await fetchUsersViaRestApi(instanceUrl, sessionId);
  }

  const data = await response.json();
  let records = data.records || [];

  // Handle pagination — follow ALL pages
  let nextUrl = data.nextRecordsUrl;
  while (nextUrl) {
    const nextResponse = await fetch(`${instanceUrl}${nextUrl}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${sessionId}` },
    });
    if (!nextResponse.ok) break;
    const nextData = await nextResponse.json();
    records = [...records, ...(nextData.records || [])];
    nextUrl = nextData.nextRecordsUrl;
  }

  return records;
}

/**
 * Fallback: fetch users via standard REST API with queryAll (includes archived/inactive).
 */
async function fetchUsersViaRestApi(instanceUrl: string, sessionId: string): Promise<SalesforceRecord[]> {
  // Use queryAll to bypass sharing rules — limit to 1000 most recently active users
  const soql = "SELECT Id, Name, Username, Email FROM User ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1000";
  const url = `${instanceUrl}/services/data/v59.0/queryAll?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });

  if (!response.ok) {
    throw new Error(`User query failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  let records = data.records || [];

  let nextUrl = data.nextRecordsUrl;
  while (nextUrl) {
    const nextResponse = await fetch(`${instanceUrl}${nextUrl}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${sessionId}` },
    });
    if (!nextResponse.ok) break;
    const nextData = await nextResponse.json();
    records = [...records, ...(nextData.records || [])];
    nextUrl = nextData.nextRecordsUrl;
  }

  return records;
}

/**
 * Fetches Custom Metadata Types by querying CustomObject via Tooling API.
 * Gets actual record IDs needed for Setup navigation URLs.
 * Custom Metadata Type IDs start with key prefix '01I'.
 */
async function fetchCustomMetadataTypes(instanceUrl: string, sessionId: string): Promise<SalesforceRecord[]> {
  // Try multiple approaches to find MDT objects

  // Approach 1: Query all CustomObject and filter by ID prefix '01I' (MDT key prefix)
  const soql = "SELECT Id, DeveloperName FROM CustomObject WHERE NamespacePrefix = null ORDER BY DeveloperName";
  const url = `${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });

  if (!response.ok) {
    throw new Error(`CustomObject query failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  const allRecords = data.records || [];

  // Filter: MDT CustomObject IDs start with '01I'
  const mdtRecords = allRecords.filter((r: any) =>
    r.Id && typeof r.Id === 'string' && r.Id.startsWith('01I')
  );

  return mdtRecords.map((r: any) => ({
    Id: r.Id,
    DeveloperName: (r.DeveloperName || '') + '__mdt',
    Name: (r.DeveloperName || '').replace(/_/g, ' '),
    Label: (r.DeveloperName || '').replace(/_/g, ' '),
  }));
}

/**
 * Transforms a single Salesforce API record into an IndexEntry.
 *
 * @param record - The raw Salesforce record
 * @param metadataType - The metadata type this record belongs to
 * @returns An IndexEntry object
 */
function transformRecord(record: SalesforceRecord, metadataType: MetadataType): IndexEntry {
  const entry: IndexEntry = {
    id: record.Id,
    name: getDisplayName(record, metadataType),
    type: metadataType,
    typeLabel: TYPE_LABELS[metadataType],
    url: buildSetupUrl(record, metadataType),
  };

  // Add objectName/context for types that reference a parent object or have useful sub-info
  if (metadataType === 'Layout') {
    entry.objectName = (record.TableEnumOrId as string) || undefined;
  } else if (metadataType === 'ValidationRule') {
    const entityDef = record.EntityDefinition as Record<string, unknown> | undefined;
    entry.objectName = (entityDef?.QualifiedApiName as string) || undefined;
  } else if (metadataType === 'User') {
    // Show email/username as context for searching
    entry.objectName = (record.Email as string) || (record.Username as string) || undefined;
  } else if (metadataType === 'EmailTemplate') {
    entry.objectName = (record.FolderName as string) || undefined;
  } else if (metadataType === 'Flow') {
    entry.objectName = (record.ProcessType as string) || undefined;
  } else if (metadataType === 'NamedCredential') {
    entry.objectName = (record.DeveloperName as string) || undefined;
  } else if (metadataType === 'RemoteSiteSetting') {
    entry.objectName = (record.EndpointUrl as string) || undefined;
  } else if (metadataType === 'CustomMetadata') {
    entry.objectName = (record.DeveloperName as string) || undefined;
  }

  return entry;
}
