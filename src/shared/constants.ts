/**
 * SFDC Metadata Navigator - Shared constants
 *
 * Configuration values, SOQL query definitions, storage keys,
 * timeout values, and default settings used across the extension.
 */

import { MetadataType, UserSettings } from './types';

// ---------------------------------------------------------------------------
// Metadata Query Configuration
// ---------------------------------------------------------------------------

/**
 * Defines the API endpoint, SOQL query, and URL template for each metadata type.
 */
export interface MetadataQueryConfig {
  /** Which Salesforce API to use: 'REST' (standard), 'TOOLING' (Tooling API), or custom handlers */
  api: 'REST' | 'TOOLING' | 'CUSTOM_MDT' | 'CUSTOM_USER';
  /** SOQL query to retrieve metadata records (empty for custom handlers) */
  query: string;
  /** URL template with {id} and optional {objectName} placeholders */
  urlTemplate: string;
}

/**
 * SOQL queries and URL templates for each supported metadata type.
 */
export const METADATA_QUERIES: Record<MetadataType, MetadataQueryConfig> = {
  Profile: {
    api: 'REST',
    query: "SELECT Id, Name FROM Profile ORDER BY Name",
    urlTemplate: '/lightning/setup/EnhancedProfiles/page?address=/{id}',
  },
  PermissionSet: {
    api: 'REST',
    query: "SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label",
    urlTemplate: '/lightning/setup/PermSets/page?address=/{id}',
  },
  Flow: {
    api: 'TOOLING',
    query: "SELECT Id, MasterLabel, ProcessType FROM Flow WHERE Status = 'Active' ORDER BY MasterLabel",
    urlTemplate: '/lightning/setup/Flows/page?address=/{id}',
  },
  EmailTemplate: {
    api: 'REST',
    query: "SELECT Id, Name, FolderName FROM EmailTemplate ORDER BY Name",
    urlTemplate: '/lightning/setup/CommunicationTemplatesEmail/page?address=/{id}',
  },
  Layout: {
    api: 'TOOLING',
    query: "SELECT Id, Name, TableEnumOrId FROM Layout ORDER BY Name",
    urlTemplate: '/lightning/setup/ObjectManager/{objectName}/PageLayouts/{id}/view',
  },
  ValidationRule: {
    api: 'TOOLING',
    query: "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true ORDER BY ValidationName",
    urlTemplate: '/lightning/setup/ObjectManager/{objectName}/ValidationRules/{id}/view',
  },
  ApexClass: {
    api: 'TOOLING',
    query: "SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
    urlTemplate: '/lightning/setup/ApexClasses/page?address=/{id}',
  },
  ApexTrigger: {
    api: 'TOOLING',
    query: "SELECT Id, Name, NamespacePrefix FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name",
    urlTemplate: '/lightning/setup/ApexTriggers/page?address=/{id}',
  },
  CustomMetadata: {
    api: 'CUSTOM_MDT',
    query: '',
    urlTemplate: '/lightning/setup/CustomMetadata/page?address=%2F{id}%3Fsetupid%3DCustomMetadata',
  },
  User: {
    api: 'CUSTOM_USER',
    query: '',
    urlTemplate: '/{id}',
  },
  CustomLabel: {
    api: 'TOOLING',
    query: "SELECT Id, Name, Value FROM ExternalString ORDER BY Name",
    urlTemplate: '/lightning/setup/ExternalStrings/page?address=/{id}',
  },
  NamedCredential: {
    api: 'TOOLING',
    query: "SELECT Id, DeveloperName, MasterLabel FROM NamedCredential ORDER BY MasterLabel",
    urlTemplate: '/lightning/setup/NamedCredential/home',
  },
  RemoteSiteSetting: {
    api: 'TOOLING',
    query: "SELECT Id, SiteName, EndpointUrl FROM RemoteProxy ORDER BY SiteName",
    urlTemplate: '/lightning/setup/SecurityRemoteProxy/home',
  },
  ConnectedApp: {
    api: 'TOOLING',
    query: "SELECT Id, Name FROM ConnectedApplication ORDER BY Name",
    urlTemplate: '/lightning/setup/ConnectedApplication/home',
  },
};

// ---------------------------------------------------------------------------
// Storage Keys
// ---------------------------------------------------------------------------

/** Prefix for per-org index storage keys. Full key: `index_{orgId}` */
export const STORAGE_KEY_PREFIX = 'index_';

/** Chrome storage key for user settings */
export const SETTINGS_KEY = 'user_settings';

// ---------------------------------------------------------------------------
// Timeout Values
// ---------------------------------------------------------------------------

/** Timeout for individual Salesforce API calls (ms) */
export const API_TIMEOUT = 30000;

/** Timeout for the entire refresh operation (ms) */
export const REFRESH_TIMEOUT = 120000;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum number of search results to display */
export const MAX_RESULTS = 20;

/** Time threshold (ms) after which the index is considered stale (24 hours) */
export const STALE_THRESHOLD = 86400000;

/** Maximum pagination hops per metadata type (prevents runaway fetches) */
export const MAX_PAGINATION_HOPS = 5;

// ---------------------------------------------------------------------------
// Default Settings
// ---------------------------------------------------------------------------

/** All supported metadata types (used as default enabled set) */
export const ALL_METADATA_TYPES: MetadataType[] = [
  'Profile',
  'PermissionSet',
  'Flow',
  'EmailTemplate',
  'Layout',
  'ValidationRule',
  'ApexClass',
  'ApexTrigger',
  'CustomMetadata',
  'User',
  'CustomLabel',
  'NamedCredential',
  'RemoteSiteSetting',
  'ConnectedApp',
];

/** Default user settings applied on first use — Users excluded by default (too many records) */
export const DEFAULT_SETTINGS: UserSettings = {
  enabledTypes: [
    'Profile',
    'PermissionSet',
    'Flow',
    'EmailTemplate',
    'Layout',
    'ValidationRule',
    'ApexClass',
    'ApexTrigger',
    'CustomMetadata',
    'CustomLabel',
    'NamedCredential',
    'RemoteSiteSetting',
    'ConnectedApp',
  ],
  maxResults: MAX_RESULTS,
  version: 1,
};
