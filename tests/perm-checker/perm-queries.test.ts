import { queryRestApi } from '../../src/background/api';
import { searchUsers, searchProfiles, getProfilePermissionSetId, getAssignedPermissionSets } from '../../src/perm-checker/perm-queries';

jest.mock('../../src/background/api', () => ({
  queryRestApi: jest.fn(),
}));

const mockedQueryRestApi = queryRestApi as jest.MockedFunction<typeof queryRestApi>;

describe('searchUsers', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('maps User records to UserSearchResult, including nested Profile.Name', async () => {
    mockedQueryRestApi.mockResolvedValue([
      { Id: '005000000000001', Name: 'Jane Doe', Username: 'jane@acme.com', ProfileId: '00e000000000001', Profile: { Name: 'Sales Rep' } },
    ] as any);

    const result = await searchUsers('https://acme.my.salesforce.com', 'sess', 'jane');

    expect(result).toEqual([
      { id: '005000000000001', name: 'Jane Doe', username: 'jane@acme.com', profileId: '00e000000000001', profileName: 'Sales Rep' },
    ]);
  });

  it('escapes single quotes in the search query before building SOQL', async () => {
    mockedQueryRestApi.mockResolvedValue([]);

    await searchUsers('https://acme.my.salesforce.com', 'sess', "O'Brien");

    const soql = mockedQueryRestApi.mock.calls[0][2];
    expect(soql).toContain("O\\'Brien");
  });
});

describe('searchProfiles', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('maps Profile records to ProfileSearchResult', async () => {
    mockedQueryRestApi.mockResolvedValue([
      { Id: '00e000000000001', Name: 'System Administrator' },
    ] as any);

    const result = await searchProfiles('https://acme.my.salesforce.com', 'sess', 'admin');

    expect(result).toEqual([{ id: '00e000000000001', name: 'System Administrator' }]);
  });
});

describe('getProfilePermissionSetId', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('returns the Id of the Profile-owned PermissionSet', async () => {
    mockedQueryRestApi.mockResolvedValue([{ Id: '0PS000000000001' }] as any);

    const result = await getProfilePermissionSetId('https://acme.my.salesforce.com', 'sess', '00e000000000001');

    expect(result).toBe('0PS000000000001');
    const soql = mockedQueryRestApi.mock.calls[0][2];
    expect(soql).toContain("ProfileId = '00e000000000001'");
  });

  it('returns null when no PermissionSet is found for the profile', async () => {
    mockedQueryRestApi.mockResolvedValue([]);

    const result = await getProfilePermissionSetId('https://acme.my.salesforce.com', 'sess', '00e000000000002');

    expect(result).toBeNull();
  });
});

describe('getAssignedPermissionSets', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('maps PermissionSetAssignment records including license info', async () => {
    mockedQueryRestApi.mockResolvedValue([
      {
        PermissionSetId: '0PS000000000002',
        PermissionSet: { Label: 'Sales Extras', LicenseId: '1000000000001AAA', License: { Name: 'Sales Cloud User' } },
      },
    ] as any);

    const result = await getAssignedPermissionSets('https://acme.my.salesforce.com', 'sess', '005000000000001');

    expect(result).toEqual([
      { permSetId: '0PS000000000002', label: 'Sales Extras', licenseId: '1000000000001AAA', licenseName: 'Sales Cloud User' },
    ]);
  });

  it('excludes group-derived assignments and profile-owned permission sets in the query', async () => {
    mockedQueryRestApi.mockResolvedValue([]);

    await getAssignedPermissionSets('https://acme.my.salesforce.com', 'sess', '005000000000001');

    const soql = mockedQueryRestApi.mock.calls[0][2];
    expect(soql).toContain('PermissionSetGroupId = null');
    expect(soql).toContain('PermissionSet.IsOwnedByProfile = false');
  });

  it('maps a PermissionSet with no license to null licenseId/licenseName', async () => {
    mockedQueryRestApi.mockResolvedValue([
      { PermissionSetId: '0PS000000000003', PermissionSet: { Label: 'No License Set', LicenseId: null, License: null } },
    ] as any);

    const result = await getAssignedPermissionSets('https://acme.my.salesforce.com', 'sess', '005000000000001');

    expect(result[0].licenseId).toBeNull();
    expect(result[0].licenseName).toBeNull();
  });
});
