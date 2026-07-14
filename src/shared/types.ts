/**
 * SFDC Metadata Navigator - Shared TypeScript interfaces and types
 *
 * Defines the core data models, message protocols, and type definitions
 * used across all extension components (popup, background, content script).
 */

/**
 * Supported Salesforce metadata types that the extension can index and search.
 */
export type MetadataType =
  | 'Profile'
  | 'PermissionSet'
  | 'Flow'
  | 'EmailTemplate'
  | 'Layout'
  | 'ValidationRule'
  | 'ApexClass'
  | 'ApexTrigger'
  | 'CustomMetadata'
  | 'User'
  | 'CustomLabel'
  | 'NamedCredential'
  | 'RemoteSiteSetting'
  | 'ConnectedApp';

/**
 * A single entry in the search index representing one Salesforce metadata item.
 */
export interface IndexEntry {
  /** Salesforce record ID (15 or 18 char) */
  id: string;
  /** Display name of the metadata item */
  name: string;
  /** Category (e.g., 'Profile', 'Flow') */
  type: MetadataType;
  /** Human-readable type label */
  typeLabel: string;
  /** Relative Setup URL path */
  url: string;
  /** Parent object name (for Layouts, ValidationRules) */
  objectName?: string;
}

/**
 * The per-org search index stored in Chrome local storage.
 */
export interface OrgIndex {
  /** 15-char Salesforce org ID */
  orgId: string;
  /** e.g., 'https://mycompany.lightning.force.com' */
  instanceUrl: string;
  /** All metadata entries for this org */
  entries: IndexEntry[];
  /** Unix timestamp (ms) of last successful refresh */
  lastRefreshed: number;
  /** Schema version for future migrations */
  version: number;
}

/**
 * User preferences stored in Chrome sync storage (with local storage fallback).
 */
export interface UserSettings {
  /** Which metadata types to include in search */
  enabledTypes: MetadataType[];
  /** Max displayed results (default: 20) */
  maxResults: number;
  /** Schema version for future migrations */
  version: number;
}

// ---------------------------------------------------------------------------
// Message Protocols (Inter-component communication)
// ---------------------------------------------------------------------------

/**
 * Messages sent from the Popup UI to the Background Service Worker.
 */
export type PopupToBackground =
  | { action: 'refreshIndex'; orgId: string; instanceUrl: string }
  | { action: 'getSessionId'; domain: string };

/**
 * Responses sent from the Background Service Worker to the Popup UI.
 */
export type BackgroundToPopup =
  | { success: true; timestamp: number }
  | { success: false; error: string };

/**
 * Messages sent from the Background Service Worker to the Content Script.
 */
export type BackgroundToContent =
  | { action: 'getOrgInfo' };

/**
 * Responses sent from the Content Script to the Background Service Worker.
 */
export type ContentToBackground =
  | { orgId: string; instanceUrl: string }
  | { error: string };

// ---------------------------------------------------------------------------
// Salesforce API response shapes
// ---------------------------------------------------------------------------

/**
 * Standard Salesforce REST/Tooling API query response.
 */
export interface SalesforceQueryResponse {
  totalSize: number;
  done: boolean;
  /** URL for next page of results (pagination, >2000 records) */
  nextRecordsUrl?: string;
  records: SalesforceRecord[];
}

/**
 * A single record returned by a Salesforce SOQL query.
 */
export interface SalesforceRecord {
  Id: string;
  [key: string]: unknown;
}
