import { queryRestApi } from '../../src/background/api';
import { searchUsers, searchProfiles } from '../../src/perm-checker/perm-queries';

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
