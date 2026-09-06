/**
 * SFDC Metadata Navigator - Background Service Worker
 *
 * Main entry point for the Chrome Extension service worker.
 * Listens for messages from the popup and handles:
 * - refreshIndex: builds the metadata search index for an org
 * - getSessionId: reads the Salesforce session cookie
 */

import { OrgIndex, PopupToBackground, UserSettings } from '../shared/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../shared/constants';
import { getSession, getSessionCookie } from './session';
import { buildIndex } from './index-builder';
import { saveOrgIndex } from './storage';
import { runOrgScan } from '../scanner/scanner';
import { OrgScanResult, ScanProgress } from '../scanner/scanner';
import {
  SessionExpiredError,
  RateLimitError,
  ServerError,
  ApiTimeoutError,
} from './api';
import {
  searchUsers,
  searchProfiles,
  getProfilePermissionSetId,
  getAssignedPermissionSets,
  getPermissionSetLicenseAssignments,
  getObjectAndFieldPermissions,
} from '../perm-checker/perm-queries';

// ---------------------------------------------------------------------------
// Error Categorization
// ---------------------------------------------------------------------------

/**
 * Maps known error types to user-facing messages.
 */
function categorizeError(error: unknown): string {
  if (error instanceof SessionExpiredError) {
    return 'Session expired — please log in to Salesforce and try again';
  }
  if (error instanceof RateLimitError) {
    return 'Salesforce API limit reached — try again later';
  }
  if (error instanceof ServerError) {
    return 'Salesforce server error — try again later';
  }
  if (error instanceof ApiTimeoutError) {
    return 'Request timed out — check your connection';
  }
  // Storage quota error detection
  if (error instanceof Error && isStorageQuotaError(error)) {
    return 'Storage full — try reducing indexed metadata types';
  }
  return 'An unexpected error occurred';
}

/**
 * Detects Chrome storage quota exceeded errors.
 */
function isStorageQuotaError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('quota') ||
    message.includes('storage') ||
    message.includes('exceeded') ||
    message.includes('bytes_per_item quota exceeded') ||
    message.includes('max_items quota exceeded')
  );
}

// ---------------------------------------------------------------------------
// Settings Loader
// ---------------------------------------------------------------------------

/**
 * Loads user settings from Chrome sync storage, falling back to local then defaults.
 */
async function loadUserSettings(): Promise<UserSettings> {
  // Try sync storage first
  try {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      return result[SETTINGS_KEY] as UserSettings;
    }
  } catch {
    // Sync storage unavailable
  }

  // Fallback: try local storage
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      return result[SETTINGS_KEY] as UserSettings;
    }
  } catch {
    // Local storage also unavailable
  }

  return DEFAULT_SETTINGS;
}

// ---------------------------------------------------------------------------
// Message Handlers
// ---------------------------------------------------------------------------

/**
 * Handles the `refreshIndex` action from the popup.
 * Reads the session cookie, builds the index, and saves it to storage.
 */
async function handleRefreshIndex(
  orgId: string,
  instanceUrl: string,
  sender: chrome.runtime.MessageSender
): Promise<{ success: true; timestamp: number } | { success: false; error: string }> {
  // Step 1: Get the API-accessible session (might be on a different domain)
  const session = await getSession(instanceUrl);
  if (!session) {
    return { success: false, error: 'Session expired — please log in to Salesforce and try again' };
  }

  // Step 2: Load user settings to determine enabled types
  const settings = await loadUserSettings();
  const enabledTypes = settings.enabledTypes;

  // Step 3: Build the index using the API-capable hostname
  const apiBaseUrl = `https://${session.hostname}`;
  const entries = await buildIndex(apiBaseUrl, session.sessionId, enabledTypes);

  // Cache session for use by other features (Org Info, Scanner)
  await chrome.storage.local.set({
    _cachedSession: {
      apiHost: session.hostname,
      sessionId: session.sessionId,
      orgId,
      timestamp: Date.now(),
    },
  });

  // Step 4: Build the OrgIndex object (store the original instanceUrl for navigation)
  const orgIndex: OrgIndex = {
    orgId,
    instanceUrl,
    entries,
    lastRefreshed: Date.now(),
    version: 1,
  };

  // Step 5: Save the index to chrome.storage.local
  await saveOrgIndex(orgIndex);

  return { success: true, timestamp: Date.now() };
}

/**
 * Handles the `getSessionId` action from the popup.
 */
async function handleGetSessionId(domain: string): Promise<{ sessionId: string | null }> {
  const sessionId = await getSessionCookie(domain);
  return { sessionId };
}

/**
 * Handles the `getOrgId` action from the popup.
 * Uses chrome.cookies API to read the sid cookie and extract the org ID from it.
 * The sid cookie value format is: orgId!restOfSessionToken
 * This is the same approach used by Salesforce Inspector Reloaded.
 */
async function handleGetOrgId(domain: string): Promise<{ orgId: string | null }> {
  try {
    // Read the sid cookie - org ID is the prefix before "!"
    const cookie = await chrome.cookies.get({ url: domain, name: 'sid' });
    if (cookie?.value) {
      const [orgId] = cookie.value.split('!');
      if (orgId && /^00D[a-zA-Z0-9]{12,15}$/.test(orgId)) {
        return { orgId };
      }
    }
  } catch { /* ignore */ }

  // Fallback: try the oid cookie directly
  try {
    const cookie = await chrome.cookies.get({ url: domain, name: 'oid' });
    if (cookie?.value && /^00D[a-zA-Z0-9]{12,15}$/.test(cookie.value)) {
      return { orgId: cookie.value };
    }
  } catch { /* ignore */ }

  return { orgId: null };
}

// ---------------------------------------------------------------------------
// Scan Handler
// ---------------------------------------------------------------------------

/**
 * Handles the `startScan` action from the scanner page.
 * Gets the session from the active Salesforce tab, then runs the full org scan.
 * Sends progress and results back via chrome.runtime.sendMessage to all listeners.
 */
async function handleStartScan(
  sender: chrome.runtime.MessageSender
): Promise<{ started: boolean; error?: string }> {
  // Find the active Salesforce tab to get the session
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let instanceUrl: string | null = null;

  // Try the sender tab first, then active tab, then any SF tab
  for (const tab of tabs) {
    if (tab.url && (tab.url.includes('.salesforce.com') || tab.url.includes('.force.com'))) {
      instanceUrl = new URL(tab.url).origin;
      break;
    }
  }

  // If active tab isn't SF, search all tabs
  if (!instanceUrl) {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (tab.url && (tab.url.includes('.salesforce.com') || tab.url.includes('.force.com'))) {
        instanceUrl = new URL(tab.url).origin;
        break;
      }
    }
  }

  if (!instanceUrl) {
    return { started: false, error: 'No Salesforce tab found. Please open a Salesforce page first.' };
  }

  // Get session
  const session = await getSession(instanceUrl);
  if (!session) {
    return { started: false, error: 'Session expired — please log in to Salesforce and try again.' };
  }

  // Get org ID from the session cookie
  const [orgId] = session.sessionId.split('!');
  if (!orgId) {
    return { started: false, error: 'Unable to identify the Salesforce org.' };
  }

  // Start the scan asynchronously (don't await — send started response immediately)
  runScanAsync(session.hostname, session.sessionId, orgId);

  return { started: true };
}

/**
 * Runs the scan asynchronously and broadcasts progress/results to all extension pages.
 */
async function runScanAsync(apiHost: string, sessionId: string, orgId: string): Promise<void> {
  try {
    const result = await runOrgScan(apiHost, sessionId, orgId, (progress: ScanProgress) => {
      // Broadcast progress to all extension pages (scanner UI)
      chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', progress }).catch(() => {
        // Ignore — no listeners
      });
    });

    // Broadcast completion
    chrome.runtime.sendMessage({ type: 'SCAN_COMPLETE', result }).catch(() => {
      // Ignore — no listeners
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Scan failed unexpectedly';
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message }).catch(() => {
      // Ignore — no listeners
    });
  }
}

/**
 * Preloads ALL fields for an object using the REST describe endpoint,
 * plus custom field IDs from the Tooling API (needed for Setup navigation links).
 */
async function handleGetAllFields(objectName: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No session' };

  const { apiHost, sessionId } = sessionInfo;
  const baseUrl = `https://${apiHost}`;

  try {
    // Run describe and custom field ID lookup in parallel
    const [describe, fieldIdMap] = await Promise.all([
      fetchJson(
        `${baseUrl}/services/data/v59.0/sobjects/${encodeURIComponent(objectName)}/describe`,
        sessionId
      ),
      getCustomFieldIds(baseUrl, sessionId, objectName),
    ]);

    if (!describe?.fields) return { fields: [] };

    const fields = describe.fields.map((f: any) => ({
      apiName: f.name || '',
      label: f.label || '',
      type: f.type || '',
      length: f.length || undefined,
      required: f.nillable === false && f.createable === true,
      custom: f.custom || false,
      objectName,
      // Custom fields need their record ID for ObjectManager URLs; standard fields use the API name
      fieldId: fieldIdMap[f.name] || '',
      helpText: f.inlineHelpText || '',
    }));

    return { fields };
  } catch {
    return { error: 'Failed to load fields' };
  }
}

/**
 * Gets a map of custom field API name -> CustomField record ID via Tooling API.
 * These IDs are required for ObjectManager Setup URLs on custom fields.
 */
async function getCustomFieldIds(baseUrl: string, sessionId: string, objectName: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};

  try {
    // For custom objects, TableEnumOrId is the CustomObject ID, not the name
    let tableEnumOrId = objectName;
    if (objectName.endsWith('__c')) {
      const devName = objectName.replace(/__c$/, '').replace(/'/g, "\\'");
      const objResult = await fetchJson(
        `${baseUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(
          `SELECT Id FROM CustomObject WHERE DeveloperName = '${devName}' LIMIT 1`
        )}`,
        sessionId
      );
      if (objResult?.records?.[0]?.Id) {
        tableEnumOrId = objResult.records[0].Id;
      }
    }

    const result = await fetchJson(
      `${baseUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(
        `SELECT Id, DeveloperName FROM CustomField WHERE TableEnumOrId = '${tableEnumOrId.replace(/'/g, "\\'")}'`
      )}`,
      sessionId
    );

    if (result?.records) {
      for (const rec of result.records) {
        // CustomField DeveloperName lacks the __c suffix; the API name has it
        map[`${rec.DeveloperName}__c`] = rec.Id;
      }
    }
  } catch { /* IDs unavailable — standard fields still work via API name */ }

  return map;
}

/**
 * Handles the `getFieldPermissions` action.
 * Queries FieldPermissions to show which profiles/permission sets can read/edit a field.
 */
async function handleGetFieldPermissions(objectName: string, fieldApiName: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No session' };

  const { apiHost, sessionId } = sessionInfo;
  const baseUrl = `https://${apiHost}`;
  const escapedObject = objectName.replace(/'/g, "\\'");
  const escapedField = `${objectName}.${fieldApiName}`.replace(/'/g, "\\'");

  try {
    const soql = `SELECT Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${escapedObject}' AND Field = '${escapedField}' ORDER BY PermissionsEdit DESC, PermissionsRead DESC LIMIT 100`;

    const result = await fetchJson(
      `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      sessionId
    );

    if (!result?.records) return { permissions: [] };

    const permissions = result.records.map((rec: any) => ({
      name: rec.Parent?.IsOwnedByProfile
        ? (rec.Parent?.Profile?.Name || 'Unknown Profile')
        : (rec.Parent?.Label || 'Unknown Permission Set'),
      isProfile: !!rec.Parent?.IsOwnedByProfile,
      read: !!rec.PermissionsRead,
      edit: !!rec.PermissionsEdit,
    }));

    return { permissions };
  } catch {
    return { error: 'Failed to query field permissions' };
  }
}

/**
 * Handles the `getFieldMetadata` action.
 * Queries FieldDefinition from Tooling API to get field details.
 */
async function handleGetFieldMetadata(fieldLabel: string, objectName: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No session' };

  const { apiHost, sessionId } = sessionInfo;
  const baseUrl = `https://${apiHost}`;
  const escapedLabel = fieldLabel.replace(/'/g, "\\'");
  const escapedObject = objectName.replace(/'/g, "\\'");

  try {
    // Query FieldDefinition for this field by label
    const soql = `SELECT DurableId, QualifiedApiName, Label, DataType, Length, IsRequired, IsCustom, InlineHelpText, EntityDefinition.QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapedObject}' AND Label = '${escapedLabel}' LIMIT 1`;

    let result = await fetchJson(
      `${baseUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql)}`,
      sessionId
    );

    if (!result?.records?.length) {
      // Try by API name (fieldLabel might be the API name)
      const soql2 = `SELECT DurableId, QualifiedApiName, Label, DataType, Length, IsRequired, IsCustom, InlineHelpText, EntityDefinition.QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapedObject}' AND QualifiedApiName = '${escapedLabel}' LIMIT 1`;
      result = await fetchJson(
        `${baseUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql2)}`,
        sessionId
      );
      if (!result?.records?.length) return { error: 'Field not found' };
    }

    const rec = result.records[0];
    const field = {
      apiName: rec.QualifiedApiName || '',
      label: rec.Label || '',
      type: rec.DataType || '',
      length: rec.Length || undefined,
      required: rec.IsRequired || false,
      custom: rec.IsCustom || false,
      objectName: rec.EntityDefinition?.QualifiedApiName || objectName,
      fieldId: rec.DurableId || '',
      helpText: rec.InlineHelpText || '',
      usedIn: { layouts: 0, validationRules: 0, flows: 0 },
    };

    return { field };
  } catch {
    return { error: 'Query failed' };
  }
}

/**
 * Handles the `getRecentlyViewed` action.
 * Queries the RecentlyViewed object for the current user's recent record visits.
 */
async function handleGetRecentlyViewed(): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No session available.' };
  }

  const baseUrl = `https://${sessionInfo.apiHost}`;
  const soql = "SELECT Id, Name, Type, LastViewedDate FROM RecentlyViewed ORDER BY LastViewedDate DESC LIMIT 15";

  try {
    const result = await fetchJson(
      `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      sessionInfo.sessionId
    );
    return { records: result?.records || [] };
  } catch {
    return { error: 'Failed to query recently viewed records.' };
  }
}

/**
 * Handles the `getOrgInfo` action from the org info dashboard page.
 * Fetches org identity, current user info, and API limits.
 */
async function handleGetOrgInfoDashboard(): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce tab found. Please open a Salesforce page first.' };
  }

  const { apiHost, sessionId } = sessionInfo;
  const baseUrl = `https://${apiHost}`;

  // Fetch all data in parallel
  const [orgData, userData, limitsData, versionsData] = await Promise.all([
    fetchJson(`${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent("SELECT Id, Name, OrganizationType, InstanceName, NamespacePrefix, IsSandbox FROM Organization")}`, sessionId),
    fetchJson(`${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent("SELECT Id, Name, Username, Email, Profile.Name, UserRole.Name FROM User WHERE Id = '" + sessionInfo.orgId.substring(0, 3) + "' LIMIT 1")}`, sessionId).catch(() => null),
    fetchJson(`${baseUrl}/services/data/v59.0/limits`, sessionId).catch(() => null),
    fetchJson(`${baseUrl}/services/data`, sessionId).catch(() => null),
  ]);

  // Get current user via identity URL
  let user: any = {};
  try {
    // Use the chatter/users/me endpoint or query the user
    const userIdFromSession = sessionInfo.sessionId.split('!')[0]; // This is actually the orgId, not userId
    // Better: use the identity endpoint
    const identityResp = await fetchJson(`${baseUrl}/services/data/v59.0/chatter/users/me`, sessionId).catch(() => null);
    if (identityResp) {
      user = {
        Id: identityResp.id,
        Name: identityResp.displayName || identityResp.name,
        Username: identityResp.username,
        Email: identityResp.email,
        ProfileName: identityResp.title || '',
        RoleName: '',
      };
    }

    // If chatter didn't work, try querying the user directly via userinfo
    if (!user.Id) {
      const userinfoResp = await fetchJson(`${baseUrl}/services/oauth2/userinfo`, sessionId).catch(() => null);
      if (userinfoResp) {
        user = {
          Id: userinfoResp.user_id,
          Name: userinfoResp.name,
          Username: userinfoResp.preferred_username || userinfoResp.email,
          Email: userinfoResp.email,
          ProfileName: '',
          RoleName: '',
        };
      }
    }

    // If still no user, try SOQL with current user's ID from chatter
    if (!user.Id && identityResp?.id) {
      const userQuery = await fetchJson(
        `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(`SELECT Id, Name, Username, Email, Profile.Name, UserRole.Name FROM User WHERE Id = '${identityResp.id}'`)}`,
        sessionId
      ).catch(() => null);
      if (userQuery?.records?.[0]) {
        const rec = userQuery.records[0];
        user = {
          Id: rec.Id,
          Name: rec.Name,
          Username: rec.Username,
          Email: rec.Email,
          ProfileName: rec.Profile?.Name || '',
          RoleName: rec.UserRole?.Name || '',
        };
      }
    }
  } catch { /* ignore user fetch failures */ }

  // Parse org data
  const org = orgData?.records?.[0] || {};

  // Get latest API version
  let apiVersion = 'v59.0';
  if (Array.isArray(versionsData)) {
    const latest = versionsData[versionsData.length - 1];
    if (latest?.version) apiVersion = `v${latest.version}`;
  }

  // Determine org type
  let orgType = org.OrganizationType || 'Unknown';
  if (org.IsSandbox) orgType += ' (Sandbox)';

  return {
    org: { ...org, OrganizationType: orgType },
    user,
    limits: limitsData,
    apiVersion,
  };
}

/**
 * Simple JSON fetch helper.
 */
async function fetchJson(url: string, sessionId: string): Promise<any> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Handles the `getStorageBreakdown` action.
 * For data storage: queries record counts per object.
 * For file storage: queries file types and sizes from ContentDocument/Attachment.
 */
async function handleGetStorageBreakdown(type: 'data' | 'file'): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce session available.' };
  }

  const baseUrl = `https://${sessionInfo.apiHost}`;
  const sessionId = sessionInfo.sessionId;

  try {
    if (type === 'data') {
      return await getDataStorageBreakdown(baseUrl, sessionId);
    } else {
      return await getFileStorageBreakdown(baseUrl, sessionId);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to load breakdown';
    return { error: msg };
  }
}

/**
 * Gets which objects a specific file type is attached to.
 * Uses ContentDocumentLink.LinkedEntityId and resolves object type dynamically.
 */
async function handleGetFileTypeObjects(fileType: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce session available.' };
  }

  const baseUrl = `https://${sessionInfo.apiHost}`;
  const sessionId = sessionInfo.sessionId;

  try {
    const escapedType = fileType.replace(/'/g, "\\'");

    // Step 1: Get ContentDocumentIds for this FileType
    const query = `SELECT ContentDocumentId FROM ContentVersion WHERE FileType = '${escapedType}' AND IsLatest = true ORDER BY ContentSize DESC LIMIT 100`;
    const cvResult = await fetchJson(
      `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(query)}`,
      sessionId
    );

    if (!cvResult?.records || cvResult.records.length === 0) {
      return { items: [] };
    }

    const docIds = cvResult.records.map((r: any) => r.ContentDocumentId).filter(Boolean);
    if (docIds.length === 0) return { items: [] };

    // Step 2: Query ContentDocumentLink for these documents
    const inClause = docIds.map((id: string) => `'${id}'`).join(',');
    const linkQuery = `SELECT LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId IN (${inClause})`;

    const linkResult = await fetchJson(
      `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(linkQuery)}`,
      sessionId
    );

    if (!linkResult?.records || linkResult.records.length === 0) {
      return { items: [] };
    }

    // Step 3: Group LinkedEntityIds by their 3-char key prefix
    const prefixCounts: Record<string, number> = {};
    for (const rec of linkResult.records) {
      const entityId = rec.LinkedEntityId as string;
      if (!entityId) continue;
      const prefix = entityId.substring(0, 3);
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }

    // Step 4: Resolve key prefixes to object names using /sobjects describe
    const prefixToName = await getKeyPrefixMap(baseUrl, sessionId);

    // Convert to items array with resolved names
    const items: Array<{ name: string; count: number }> = [];
    for (const [prefix, count] of Object.entries(prefixCounts)) {
      const name = prefixToName[prefix] || `Unknown (${prefix})`;
      const existing = items.find(i => i.name === name);
      if (existing) { existing.count += count; }
      else { items.push({ name, count }); }
    }

    return { items };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to query file objects';
    return { error: msg };
  }
}

// ---------------------------------------------------------------------------
// Perm Checker Handlers
// ---------------------------------------------------------------------------

async function handleSearchUsers(query: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const users = await searchUsers(`https://${sessionInfo.apiHost}`, sessionInfo.sessionId, query);
    return { users };
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

async function handleSearchProfiles(query: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const profiles = await searchProfiles(`https://${sessionInfo.apiHost}`, sessionInfo.sessionId, query);
    return { profiles };
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

/**
 * Searches SObjects by name/label substring via a fresh /sobjects describe
 * call. Deliberately not sharing getKeyPrefixMap's cache — that map is keyed
 * by 3-char key prefix (for resolving record IDs to object names), not by
 * searchable name/label, so reusing it would need its own lookup structure.
 * Not worth the complexity for a search box the user runs a handful of times.
 */
async function handleSearchObjects(query: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };

  const baseUrl = `https://${sessionInfo.apiHost}`;
  try {
    const data = await fetchJson(`${baseUrl}/services/data/v59.0/sobjects`, sessionInfo.sessionId);
    const lowerQuery = query.toLowerCase();
    const objects = (data?.sobjects || [])
      .filter((o: any) => o.queryable)
      .map((o: any) => ({ apiName: o.name as string, label: o.label as string }))
      .filter((o: { apiName: string; label: string }) =>
        o.apiName.toLowerCase().includes(lowerQuery) || o.label.toLowerCase().includes(lowerQuery)
      )
      .slice(0, 20);
    return { objects };
  } catch {
    return { error: 'Failed to load objects.' };
  }
}

async function handleGetProfilePermissionSetId(profileId: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const permSetId = await getProfilePermissionSetId(`https://${sessionInfo.apiHost}`, sessionInfo.sessionId, profileId);
    return { permSetId };
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

async function handleGetAssignedPermissionSets(userId: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const permissionSets = await getAssignedPermissionSets(`https://${sessionInfo.apiHost}`, sessionInfo.sessionId, userId);
    return { permissionSets };
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

async function handleGetPermissionSetLicenseAssignments(userId: string): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const licenseIds = await getPermissionSetLicenseAssignments(`https://${sessionInfo.apiHost}`, sessionInfo.sessionId, userId);
    return { licenseIds: Array.from(licenseIds) };
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

async function handleGetObjectAndFieldPermissions(
  permissionSetIds: string[],
  objectApiName: string,
  fieldApiName: string | null
): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) return { error: 'No Salesforce session available.' };
  try {
    const result = await getObjectAndFieldPermissions(
      `https://${sessionInfo.apiHost}`,
      sessionInfo.sessionId,
      permissionSetIds,
      objectApiName,
      fieldApiName
    );
    return result;
  } catch (error: unknown) {
    return { error: categorizeError(error) };
  }
}

/**
 * Gets a mapping of key prefix → object label by querying /sobjects.
 * Caches the result in chrome.storage.local for persistence across service worker restarts.
 */
let cachedPrefixMap: Record<string, string> | null = null;

async function getKeyPrefixMap(baseUrl: string, sessionId: string): Promise<Record<string, string>> {
  // Check in-memory cache first
  if (cachedPrefixMap) return cachedPrefixMap;

  // Check storage cache (valid for 24 hours)
  try {
    const stored = await chrome.storage.local.get('_keyPrefixMap');
    if (stored._keyPrefixMap && (Date.now() - stored._keyPrefixMap.timestamp < 86400000)) {
      cachedPrefixMap = stored._keyPrefixMap.map;
      return cachedPrefixMap!;
    }
  } catch { /* ignore */ }

  // Fetch from Salesforce
  try {
    const data = await fetchJson(`${baseUrl}/services/data/v59.0/sobjects`, sessionId);
    const map: Record<string, string> = {};

    if (data?.sobjects) {
      for (const obj of data.sobjects) {
        if (obj.keyPrefix) {
          map[obj.keyPrefix] = obj.label || obj.name;
        }
      }
    }

    cachedPrefixMap = map;
    // Persist to storage
    await chrome.storage.local.set({ _keyPrefixMap: { map, timestamp: Date.now() } });
    return map;
  } catch {
    // Return a basic fallback map
    return {
      '001': 'Account', '003': 'Contact', '005': 'User',
      '006': 'Opportunity', '00Q': 'Lead', '500': 'Case',
      '00D': 'Organization', '00T': 'Task', '00U': 'Event',
      '068': 'Content Workspace', '701': 'Campaign',
    };
  }
}

/**
 * Gets data storage breakdown — uses a single query for storage usage by entity.
 */
async function getDataStorageBreakdown(baseUrl: string, sessionId: string): Promise<any> {
  const items: Array<{ name: string; count: number; size: number }> = [];

  // Try EntityParticle/Storage usage query first (single fast query)
  try {
    const result = await fetchJson(
      `${baseUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(
        "SELECT DurableId, Label, RecordCount FROM EntityDefinition WHERE RecordCount > 0 ORDER BY RecordCount DESC LIMIT 25"
      )}`,
      sessionId
    );

    if (result?.records) {
      for (const rec of result.records) {
        items.push({
          name: rec.Label || rec.DurableId || 'Unknown',
          count: rec.RecordCount || 0,
          size: rec.RecordCount || 0,
        });
      }
      return { items };
    }
  } catch {
    // EntityDefinition with RecordCount might not be available
  }

  // Fallback: query just the top 5 largest objects individually
  const topObjects = ['Contact', 'Account', 'Opportunity', 'Lead', 'Case'];
  for (const obj of topObjects) {
    try {
      const result = await fetchJson(
        `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${obj}`)}`,
        sessionId
      );
      if (result?.totalSize > 0) {
        items.push({ name: obj, count: result.totalSize, size: result.totalSize });
      }
    } catch { /* skip */ }
  }

  return { items };
}

/**
 * Gets file storage breakdown by querying ContentVersion grouped by FileType.
 */
async function getFileStorageBreakdown(baseUrl: string, sessionId: string): Promise<any> {
  const items: Array<{ name: string; count: number; size: number }> = [];

  try {
    // Query ContentVersion grouped by FileType
    const result = await fetchJson(
      `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(
        "SELECT FileType, COUNT(Id) cnt, SUM(ContentSize) totalSize FROM ContentVersion GROUP BY FileType ORDER BY SUM(ContentSize) DESC LIMIT 20"
      )}`,
      sessionId
    );

    if (result?.records) {
      for (const rec of result.records) {
        items.push({
          name: rec.FileType || 'Unknown',
          count: rec.cnt || 0,
          size: Math.round((rec.totalSize || 0) / (1024 * 1024)), // Convert bytes to MB
        });
      }
    }
  } catch {
    // ContentVersion might not be accessible — try Attachment
    try {
      const result = await fetchJson(
        `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(
          "SELECT ContentType, COUNT(Id) cnt, SUM(BodyLength) totalSize FROM Attachment GROUP BY ContentType ORDER BY SUM(BodyLength) DESC LIMIT 20"
        )}`,
        sessionId
      );

      if (result?.records) {
        for (const rec of result.records) {
          items.push({
            name: rec.ContentType || 'Unknown',
            count: rec.cnt || 0,
            size: Math.round((rec.totalSize || 0) / (1024 * 1024)),
          });
        }
      }
    } catch {
      return { error: 'Unable to query file storage details.' };
    }
  }

  return { items };
}

/**
 * Gets the session info needed for scanner operations.
 * Finds a Salesforce tab and reads the session.
 */
async function getScannerSession(): Promise<{ apiHost: string; sessionId: string; orgId: string } | null> {
  // Strategy 1: Use cached session from last successful popup interaction
  try {
    const cached = await chrome.storage.local.get('_cachedSession');
    if (cached._cachedSession) {
      const { apiHost, sessionId, orgId, timestamp } = cached._cachedSession;
      // Use cached session if less than 1 hour old
      if (Date.now() - timestamp < 3600000 && apiHost && sessionId && orgId) {
        return { apiHost, sessionId, orgId };
      }
    }
  } catch { /* ignore */ }

  // Strategy 2: Find a Salesforce tab and use its URL
  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (tab.url && (tab.url.includes('.salesforce.com') || tab.url.includes('.force.com'))) {
        const instanceUrl = new URL(tab.url).origin;
        const session = await getSession(instanceUrl);
        if (session) {
          const [orgId] = session.sessionId.split('!');
          if (orgId) {
            const result = { apiHost: session.hostname, sessionId: session.sessionId, orgId };
            // Cache for future use
            await chrome.storage.local.set({ _cachedSession: { ...result, timestamp: Date.now() } });
            return result;
          }
        }
      }
    }
  } catch { /* tabs query failed */ }

  // Strategy 3: Search sid cookies for a specific subdomain
  const sfDomains = ['salesforce.com', 'force.com'];
  for (const domain of sfDomains) {
    try {
      const cookies = await chrome.cookies.getAll({ name: 'sid', domain, secure: true });
      for (const cookie of cookies) {
        if (!cookie.value || !cookie.value.includes('!')) continue;

        const [orgId] = cookie.value.split('!');
        if (!orgId || !/^00D/.test(orgId)) continue;

        const hostname = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
        if (hostname === 'salesforce.com' || hostname === 'force.com') continue;
        if (hostname.includes('help.salesforce.com')) continue;

        const result = { apiHost: hostname, sessionId: cookie.value, orgId };
        await chrome.storage.local.set({ _cachedSession: { ...result, timestamp: Date.now() } });
        return result;
      }
    } catch { /* continue */ }
  }

  return null;
}

/**
 * Handles the `getRecentClasses` action: fetches 10 most recently modified Apex classes.
 */
async function handleGetRecentClasses(): Promise<any> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce session available.' };
  }

  const { apiHost, sessionId } = sessionInfo;

  try {
    const soql = "SELECT Id, Name, LastModifiedDate, CreatedDate FROM ApexClass WHERE NamespacePrefix = null AND (NOT Name LIKE '%Test%') AND (NOT Name LIKE '%_Test') AND (NOT Name LIKE '%Mock%') ORDER BY LastModifiedDate DESC LIMIT 10";
    const records = await fetchToolingQuery(apiHost, sessionId, soql);

    // Mark classes as "new" if created in the last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const classes = records.map((r: any) => ({
      Id: r.Id,
      Name: r.Name,
      LastModifiedDate: r.LastModifiedDate,
      CreatedDate: r.CreatedDate,
      isNew: new Date(r.CreatedDate).getTime() > sevenDaysAgo,
    }));

    return { classes };
  } catch (error: unknown) {
    return { error: 'Failed to load recent classes' };
  }
}

/**
 * Handles the `searchClasses` action: searches class names using LIKE query.
 */
async function handleSearchClasses(query: string): Promise<{ classes?: Array<{ Id: string; Name: string; type: string }>; error?: string }> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce tab found. Open a Salesforce page first.' };
  }

  const { apiHost, sessionId } = sessionInfo;
  const escapedQuery = query.replace(/'/g, "\\'");

  try {
    const classQuery = `SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Name LIKE '%${escapedQuery}%' ORDER BY Name LIMIT 20`;
    const classRecords = await fetchToolingQuery(apiHost, sessionId, classQuery);
    const classes = classRecords.map((r: any) => ({ Id: r.Id, Name: r.Name, type: 'class' }));

    let triggers: Array<{ Id: string; Name: string; type: string }> = [];
    try {
      const triggerQuery = `SELECT Id, Name FROM ApexTrigger WHERE NamespacePrefix = null AND Name LIKE '%${escapedQuery}%' ORDER BY Name LIMIT 10`;
      const triggerRecords = await fetchToolingQuery(apiHost, sessionId, triggerQuery);
      triggers = triggerRecords.map((r: any) => ({ Id: r.Id, Name: r.Name, type: 'trigger' }));
    } catch { /* triggers might not be accessible */ }

    return { classes: [...classes, ...triggers] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Search failed';
    return { error: msg };
  }
}

/**
 * Handles the `getClassList` action: fetches class/trigger names (no bodies).
 */
async function handleGetClassList(): Promise<{ classes?: Array<{ Id: string; Name: string; type: string }>; error?: string }> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce tab found. Please open a Salesforce page first.' };
  }

  const { apiHost, sessionId } = sessionInfo;

  try {
    // Fetch class names (no Body — lightweight)
    const classQuery = "SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name";
    const triggerQuery = "SELECT Id, Name FROM ApexTrigger WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name";

    const classResponse = await fetchToolingQuery(apiHost, sessionId, classQuery);
    const classes = classResponse.map((r: any) => ({ Id: r.Id, Name: r.Name, type: 'class' }));

    let triggers: Array<{ Id: string; Name: string; type: string }> = [];
    try {
      const triggerResponse = await fetchToolingQuery(apiHost, sessionId, triggerQuery);
      triggers = triggerResponse.map((r: any) => ({ Id: r.Id, Name: r.Name, type: 'trigger' }));
    } catch { /* triggers might not be accessible */ }

    return { classes: [...classes, ...triggers] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to fetch class list';
    return { error: msg };
  }
}

/**
 * Handles the `scanSelected` action: fetches bodies for selected IDs and runs analysis.
 */
async function handleScanSelected(classIds: string[]): Promise<{ started?: boolean; error?: string }> {
  const sessionInfo = await getScannerSession();
  if (!sessionInfo) {
    return { error: 'No Salesforce tab found. Please open a Salesforce page first.' };
  }

  // Run scan asynchronously
  runSelectedScanAsync(sessionInfo.apiHost, sessionInfo.sessionId, sessionInfo.orgId, classIds);
  return { started: true };
}

/**
 * Runs scan on selected classes asynchronously, broadcasting progress.
 */
async function runSelectedScanAsync(
  apiHost: string,
  sessionId: string,
  orgId: string,
  classIds: string[]
): Promise<void> {
  try {
    const { analyzeApexClass } = await import('../scanner/rules');
    const total = classIds.length;
    const results: import('../scanner/rules').ScanResult[] = [];
    const summary = { critical: 0, warning: 0, info: 0 };
    const categories = {
      bulkification: 0,
      performance: 0,
      security: 0,
      'best-practice': 0,
      maintainability: 0,
    };

    // Fetch and analyze in batches to avoid API limits
    const batchSize = 10;
    let completed = 0;

    for (let i = 0; i < classIds.length; i += batchSize) {
      const batch = classIds.slice(i, i + batchSize);
      const idsStr = batch.map(id => `'${id}'`).join(',');

      // Try ApexClass first, then ApexTrigger for any not found
      const query = `SELECT Id, Name, Body FROM ApexClass WHERE Id IN (${idsStr})`;
      let records = await fetchToolingQuery(apiHost, sessionId, query);

      // Also try triggers
      const foundIds = new Set(records.map((r: any) => r.Id));
      const missingIds = batch.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        const triggerIdsStr = missingIds.map(id => `'${id}'`).join(',');
        const triggerQuery = `SELECT Id, Name, Body FROM ApexTrigger WHERE Id IN (${triggerIdsStr})`;
        try {
          const triggerRecords = await fetchToolingQuery(apiHost, sessionId, triggerQuery);
          records = [...records, ...triggerRecords];
        } catch { /* ignore */ }
      }

      // Analyze each record
      for (const record of records) {
        const name = record.Name as string;
        const body = record.Body as string;
        if (!body) continue;

        completed++;
        chrome.runtime.sendMessage({
          type: 'SCAN_PROGRESS',
          progress: { total, completed, currentClass: name, done: false },
        }).catch(() => {});

        const result = analyzeApexClass(body, name, record.Id);
        if (result.violations.length > 0) {
          results.push(result);
          for (const v of result.violations) {
            summary[v.severity]++;
            categories[v.category]++;
          }
        }
      }
    }

    // Broadcast completion
    const totalViolations = summary.critical + summary.warning + summary.info;
    const scanResult: import('../scanner/scanner').OrgScanResult = {
      orgId,
      timestamp: Date.now(),
      totalClasses: total,
      classesWithIssues: results.length,
      totalViolations,
      results,
      summary,
      categories,
    };

    chrome.runtime.sendMessage({ type: 'SCAN_COMPLETE', result: scanResult }).catch(() => {});
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Scan failed unexpectedly';
    chrome.runtime.sendMessage({ type: 'SCAN_ERROR', error: message }).catch(() => {});
  }
}

/**
 * Helper: executes a Tooling API query and returns records.
 */
async function fetchToolingQuery(apiHost: string, sessionId: string, soql: string): Promise<any[]> {
  const url = `https://${apiHost}/services/data/v59.0/tooling/query?q=${encodeURIComponent(soql)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${sessionId}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Session expired — please log in to Salesforce and try again');
    throw new Error(`API error (HTTP ${response.status})`);
  }

  const data = await response.json();
  return data.records || [];
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

/**
 * Primary message listener for the background service worker.
 * Routes incoming messages to the appropriate handler.
 */
chrome.runtime.onMessage.addListener(
  (
    message: PopupToBackground,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean => {
    if (message.action === 'refreshIndex') {
      handleRefreshIndex(message.orgId, message.instanceUrl, sender)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({ success: false, error: categorizeError(error) });
        });
      // Return true to indicate async response
      return true;
    }

    if (message.action === 'getSessionId') {
      handleGetSessionId(message.domain)
        .then(sendResponse)
        .catch(() => {
          sendResponse({ sessionId: null });
        });
      // Return true to indicate async response
      return true;
    }

    if ((message as any).action === 'getOrgId') {
      handleGetOrgId((message as any).domain)
        .then(sendResponse)
        .catch(() => {
          sendResponse({ orgId: null });
        });
      return true;
    }

    if ((message as any).action === 'getOrgInfo') {
      handleGetOrgInfoDashboard()
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to load org info';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'getRecentlyViewed') {
      handleGetRecentlyViewed()
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({ error: 'Failed to load recent records' });
        });
      return true;
    }

    if ((message as any).action === 'getFieldMetadata') {
      handleGetFieldMetadata((message as any).fieldLabel, (message as any).objectName)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed' }));
      return true;
    }

    if ((message as any).action === 'getAllFieldsForObject') {
      handleGetAllFields((message as any).objectName)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed' }));
      return true;
    }

    if ((message as any).action === 'getFieldPermissions') {
      handleGetFieldPermissions((message as any).objectName, (message as any).fieldApiName)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed' }));
      return true;
    }

    if ((message as any).action === 'openUrl') {
      // Open a setup URL in a new tab (from field inspector tooltip links)
      (async () => {
        const url = (message as any).url as string;

        // Classic paths (/p/...) work best on the my.salesforce.com API host
        if (url.startsWith('/p/')) {
          const sessionInfo = await getScannerSession().catch(() => null);
          if (sessionInfo?.apiHost) {
            chrome.tabs.create({ url: `https://${sessionInfo.apiHost}${url}` });
            return;
          }
        }

        // Lightning paths use the active tab's origin
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
          const origin = new URL(tab.url).origin;
          chrome.tabs.create({ url: origin + url });
        }
      })();
      return false;
    }

    if ((message as any).action === 'getStorageBreakdown') {
      handleGetStorageBreakdown((message as any).type)
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to load breakdown';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'getFileTypeObjects') {
      handleGetFileTypeObjects((message as any).fileType)
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to load objects';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'startScan') {
      handleStartScan(sender)
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Scan failed';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'getClassList') {
      handleGetClassList()
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to load classes';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'searchClasses') {
      handleSearchClasses((message as any).query)
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Search failed';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'getRecentClasses') {
      handleGetRecentClasses()
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({ error: 'Failed to load recent classes' });
        });
      return true;
    }

    if ((message as any).action === 'scanSelected') {
      handleScanSelected((message as any).classIds)
        .then(sendResponse)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Scan failed';
          sendResponse({ error: msg });
        });
      return true;
    }

    if ((message as any).action === 'searchUsers') {
      handleSearchUsers((message as any).query)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Search failed' }));
      return true;
    }

    if ((message as any).action === 'searchProfiles') {
      handleSearchProfiles((message as any).query)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Search failed' }));
      return true;
    }

    if ((message as any).action === 'searchObjects') {
      handleSearchObjects((message as any).query)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Search failed' }));
      return true;
    }

    if ((message as any).action === 'getProfilePermissionSetId') {
      handleGetProfilePermissionSetId((message as any).profileId)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed to resolve profile' }));
      return true;
    }

    if ((message as any).action === 'getAssignedPermissionSets') {
      handleGetAssignedPermissionSets((message as any).userId)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed to load permission sets' }));
      return true;
    }

    if ((message as any).action === 'getPermissionSetLicenseAssignments') {
      handleGetPermissionSetLicenseAssignments((message as any).userId)
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed to load license assignments' }));
      return true;
    }

    if ((message as any).action === 'getObjectAndFieldPermissions') {
      handleGetObjectAndFieldPermissions(
        (message as any).permissionSetIds,
        (message as any).objectApiName,
        (message as any).fieldApiName
      )
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Failed to load permissions' }));
      return true;
    }

    return false;
  }
);
