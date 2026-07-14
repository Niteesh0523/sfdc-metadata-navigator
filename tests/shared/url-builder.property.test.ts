/**
 * Property Test: URL Construction (Property 7)
 *
 * Property 7: Index entry URL construction produces valid navigation URLs
 * For any metadata record returned by the Salesforce API, the URL construction
 * function shall produce a relative URL path that starts with `/lightning/setup/`
 * and contains the record's Salesforce ID.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 7: Index entry URL construction produces valid navigation URLs
 * Validates: Requirements 5.1
 */

import * as fc from 'fast-check';
import { buildSetupUrl, getDisplayName } from '../../src/shared/url-builder';
import { MetadataType, SalesforceRecord } from '../../src/shared/types';

describe('Property 7: Index entry URL construction produces valid navigation URLs', () => {
  // Arbitrary for generating valid 18-char Salesforce IDs
  const salesforceIdArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 15, maxLength: 15 }
  ).map(s => '001' + s); // Prefix with a valid-looking key prefix

  // Arbitrary for generating object API names (alphanumeric + underscores)
  const objectNameArb = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
    { minLength: 1, maxLength: 30 }
  ).filter(s => /^[A-Za-z]/.test(s)); // Must start with a letter

  // All metadata types
  const allTypes: MetadataType[] = [
    'Profile', 'PermissionSet', 'Flow', 'EmailTemplate',
    'Layout', 'ValidationRule', 'ApexClass',
  ];

  // Simple metadata types (no objectName substitution)
  const simpleTypes: MetadataType[] = [
    'Profile', 'PermissionSet', 'Flow', 'EmailTemplate', 'ApexClass',
  ];

  // Types requiring objectName
  const objectTypes: MetadataType[] = ['Layout', 'ValidationRule'];

  /**
   * Builds a mock SalesforceRecord for the given metadata type.
   */
  function buildMockRecord(
    id: string,
    metadataType: MetadataType,
    objectName: string
  ): SalesforceRecord {
    const record: SalesforceRecord = { Id: id };

    switch (metadataType) {
      case 'Profile':
        record.Name = 'Test Profile';
        break;
      case 'PermissionSet':
        record.Name = 'TestPermSet';
        record.Label = 'Test Permission Set';
        break;
      case 'Flow':
        record.MasterLabel = 'Test Flow';
        record.ProcessType = 'AutoLaunchedFlow';
        break;
      case 'EmailTemplate':
        record.Name = 'Test Template';
        record.FolderName = 'TestFolder';
        break;
      case 'Layout':
        record.Name = 'Test Layout';
        record.TableEnumOrId = objectName;
        break;
      case 'ValidationRule':
        record.ValidationName = 'Test_Rule';
        record.EntityDefinition = { QualifiedApiName: objectName };
        break;
      case 'ApexClass':
        record.Name = 'TestClass';
        record.NamespacePrefix = null;
        break;
    }

    return record;
  }

  it('should produce URLs starting with /lightning/setup/ for all simple metadata types', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...simpleTypes),
        (id, metadataType) => {
          const record = buildMockRecord(id, metadataType, '');
          const url = buildSetupUrl(record, metadataType);

          expect(url).toMatch(/^\/lightning\/setup\//);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce URLs starting with /lightning/setup/ for object-scoped metadata types', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...objectTypes),
        objectNameArb,
        (id, metadataType, objectName) => {
          const record = buildMockRecord(id, metadataType, objectName);
          const url = buildSetupUrl(record, metadataType);

          expect(url).toMatch(/^\/lightning\/setup\//);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always contain the record ID in the generated URL', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...allTypes),
        objectNameArb,
        (id, metadataType, objectName) => {
          const record = buildMockRecord(id, metadataType, objectName);
          const url = buildSetupUrl(record, metadataType);

          expect(url).toContain(id);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should contain the object name for Layout and ValidationRule types', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...objectTypes),
        objectNameArb,
        (id, metadataType, objectName) => {
          const record = buildMockRecord(id, metadataType, objectName);
          const url = buildSetupUrl(record, metadataType);

          expect(url).toContain(objectName);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should not contain unresolved template placeholders', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...allTypes),
        objectNameArb,
        (id, metadataType, objectName) => {
          const record = buildMockRecord(id, metadataType, objectName);
          const url = buildSetupUrl(record, metadataType);

          expect(url).not.toContain('{id}');
          expect(url).not.toContain('{objectName}');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return a non-empty display name for all metadata types with valid records', () => {
    fc.assert(
      fc.property(
        salesforceIdArb,
        fc.constantFrom(...allTypes),
        objectNameArb,
        (id, metadataType, objectName) => {
          const record = buildMockRecord(id, metadataType, objectName);
          const name = getDisplayName(record, metadataType);

          expect(name.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
