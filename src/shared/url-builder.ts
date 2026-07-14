/**
 * SFDC Metadata Navigator - URL Construction Utility
 *
 * Provides functions to build Salesforce Setup URLs from metadata records
 * and extract display names based on metadata type.
 */

import { MetadataType, SalesforceRecord } from './types';
import { METADATA_QUERIES } from './constants';

/**
 * Builds a relative Salesforce Setup URL for a given metadata record.
 *
 * Substitutes `{id}` with the record's Salesforce ID and `{objectName}`
 * with the appropriate object reference field based on metadata type:
 * - Layout: uses `TableEnumOrId`
 * - ValidationRule: uses `EntityDefinition.QualifiedApiName`
 *
 * @param record - The Salesforce record returned from an API query
 * @param metadataType - The type of metadata this record represents
 * @returns A relative URL path starting with `/lightning/setup/`
 */
export function buildSetupUrl(record: SalesforceRecord, metadataType: MetadataType): string {
  const config = METADATA_QUERIES[metadataType];
  let url = config.urlTemplate;

  // Substitute the record ID
  url = url.replace('{id}', record.Id);

  // Substitute object name if the template requires it
  if (url.includes('{objectName}')) {
    let objectName = '';

    if (metadataType === 'Layout') {
      objectName = (record.TableEnumOrId as string) || '';
    } else if (metadataType === 'ValidationRule') {
      // EntityDefinition.QualifiedApiName comes back as a nested object
      const entityDef = record.EntityDefinition as Record<string, unknown> | undefined;
      objectName = (entityDef?.QualifiedApiName as string) || '';
    }

    url = url.replace('{objectName}', objectName);
  }

  return url;
}

/**
 * Extracts the human-readable display name from a Salesforce record
 * based on the metadata type conventions:
 *
 * - Profile: `Name`
 * - PermissionSet: `Label` (fallback to `Name`)
 * - Flow: `MasterLabel`
 * - EmailTemplate: `Name`
 * - Layout: `Name`
 * - ValidationRule: `ValidationName`
 * - ApexClass: `Name`
 *
 * @param record - The Salesforce record returned from an API query
 * @param metadataType - The type of metadata this record represents
 * @returns The display name string
 */
export function getDisplayName(record: SalesforceRecord, metadataType: MetadataType): string {
  switch (metadataType) {
    case 'Profile':
      return (record.Name as string) || '';
    case 'PermissionSet':
      return (record.Label as string) || (record.Name as string) || '';
    case 'Flow':
      return (record.MasterLabel as string) || '';
    case 'EmailTemplate':
      return (record.Name as string) || '';
    case 'Layout':
      return (record.Name as string) || '';
    case 'ValidationRule':
      return (record.ValidationName as string) || '';
    case 'ApexClass':
      return (record.Name as string) || '';
    case 'ApexTrigger':
      return (record.Name as string) || '';
    case 'CustomMetadata':
      return (record.Label as string) || (record.Name as string) || (record.DeveloperName as string) || '';
    case 'User': {
      return (record.Name as string) || (record.Username as string) || '';
    }
    case 'CustomLabel':
      return (record.Name as string) || '';
    case 'NamedCredential':
      return (record.MasterLabel as string) || (record.DeveloperName as string) || '';
    case 'RemoteSiteSetting':
      return (record.SiteName as string) || '';
    case 'ConnectedApp':
      return (record.Name as string) || '';
  }
}
