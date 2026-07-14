import { buildSetupUrl, getDisplayName } from '../../src/shared/url-builder';
import { SalesforceRecord, MetadataType } from '../../src/shared/types';

describe('buildSetupUrl', () => {
  it('builds Profile URL with substituted ID', () => {
    const record: SalesforceRecord = { Id: '00e5g000001ABC' };
    const url = buildSetupUrl(record, 'Profile');
    expect(url).toBe('/lightning/setup/EnhancedProfiles/page?address=/00e5g000001ABC');
  });

  it('builds PermissionSet URL with substituted ID', () => {
    const record: SalesforceRecord = { Id: '0PS5g000002DEF' };
    const url = buildSetupUrl(record, 'PermissionSet');
    expect(url).toBe('/lightning/setup/PermSets/page?address=/0PS5g000002DEF');
  });

  it('builds Flow URL with substituted ID', () => {
    const record: SalesforceRecord = { Id: '3015g000003GHI' };
    const url = buildSetupUrl(record, 'Flow');
    expect(url).toBe('/lightning/setup/Flows/page?address=/3015g000003GHI');
  });

  it('builds EmailTemplate URL with substituted ID', () => {
    const record: SalesforceRecord = { Id: '00X5g000004JKL' };
    const url = buildSetupUrl(record, 'EmailTemplate');
    expect(url).toBe('/lightning/setup/CommunicationTemplatesEmail/page?address=/00X5g000004JKL');
  });

  it('builds Layout URL with substituted ID and objectName from TableEnumOrId', () => {
    const record: SalesforceRecord = { Id: '00h5g000005MNO', TableEnumOrId: 'Account' };
    const url = buildSetupUrl(record, 'Layout');
    expect(url).toBe('/lightning/setup/ObjectManager/Account/PageLayouts/00h5g000005MNO/view');
  });

  it('builds ValidationRule URL with substituted ID and objectName from EntityDefinition', () => {
    const record: SalesforceRecord = {
      Id: '03d5g000006PQR',
      EntityDefinition: { QualifiedApiName: 'Opportunity' },
    };
    const url = buildSetupUrl(record, 'ValidationRule');
    expect(url).toBe('/lightning/setup/ObjectManager/Opportunity/ValidationRules/03d5g000006PQR/view');
  });

  it('builds ApexClass URL with substituted ID', () => {
    const record: SalesforceRecord = { Id: '01p5g000007STU' };
    const url = buildSetupUrl(record, 'ApexClass');
    expect(url).toBe('/lightning/setup/ApexClasses/page?address=/01p5g000007STU');
  });

  it('handles Layout with missing TableEnumOrId gracefully', () => {
    const record: SalesforceRecord = { Id: '00h5g000005MNO' };
    const url = buildSetupUrl(record, 'Layout');
    expect(url).toBe('/lightning/setup/ObjectManager//PageLayouts/00h5g000005MNO/view');
  });

  it('handles ValidationRule with missing EntityDefinition gracefully', () => {
    const record: SalesforceRecord = { Id: '03d5g000006PQR' };
    const url = buildSetupUrl(record, 'ValidationRule');
    expect(url).toBe('/lightning/setup/ObjectManager//ValidationRules/03d5g000006PQR/view');
  });
});

describe('getDisplayName', () => {
  it('returns Name for Profile', () => {
    const record: SalesforceRecord = { Id: '001', Name: 'System Administrator' };
    expect(getDisplayName(record, 'Profile')).toBe('System Administrator');
  });

  it('returns Label for PermissionSet when available', () => {
    const record: SalesforceRecord = { Id: '002', Name: 'Sales_User', Label: 'Sales User' };
    expect(getDisplayName(record, 'PermissionSet')).toBe('Sales User');
  });

  it('falls back to Name for PermissionSet when Label is missing', () => {
    const record: SalesforceRecord = { Id: '002', Name: 'Sales_User' };
    expect(getDisplayName(record, 'PermissionSet')).toBe('Sales_User');
  });

  it('returns MasterLabel for Flow', () => {
    const record: SalesforceRecord = { Id: '003', MasterLabel: 'My Automation Flow' };
    expect(getDisplayName(record, 'Flow')).toBe('My Automation Flow');
  });

  it('returns Name for EmailTemplate', () => {
    const record: SalesforceRecord = { Id: '004', Name: 'Welcome Email' };
    expect(getDisplayName(record, 'EmailTemplate')).toBe('Welcome Email');
  });

  it('returns Name for Layout', () => {
    const record: SalesforceRecord = { Id: '005', Name: 'Account Layout' };
    expect(getDisplayName(record, 'Layout')).toBe('Account Layout');
  });

  it('returns ValidationName for ValidationRule', () => {
    const record: SalesforceRecord = { Id: '006', ValidationName: 'Require_Close_Date' };
    expect(getDisplayName(record, 'ValidationRule')).toBe('Require_Close_Date');
  });

  it('returns Name for ApexClass', () => {
    const record: SalesforceRecord = { Id: '007', Name: 'AccountTriggerHandler' };
    expect(getDisplayName(record, 'ApexClass')).toBe('AccountTriggerHandler');
  });

  it('returns empty string when expected field is missing', () => {
    const record: SalesforceRecord = { Id: '008' };
    expect(getDisplayName(record, 'Profile')).toBe('');
    expect(getDisplayName(record, 'Flow')).toBe('');
    expect(getDisplayName(record, 'ValidationRule')).toBe('');
  });
});
