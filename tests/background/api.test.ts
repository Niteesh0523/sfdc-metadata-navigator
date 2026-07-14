/**
 * Unit tests for the Salesforce API query module.
 *
 * Tests cover: successful queries, pagination, timeout handling,
 * HTTP error categorization, and Tooling API URL construction.
 */

import {
  queryRestApi,
  queryToolingApi,
  executeQuery,
  SessionExpiredError,
  RateLimitError,
  ServerError,
  ApiTimeoutError,
} from '../../src/background/api';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// AbortController mock
// ---------------------------------------------------------------------------

const mockAbort = jest.fn();
class MockAbortController {
  signal = 'mock-signal';
  abort = mockAbort;
}
(global as any).AbortController = MockAbortController;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSuccessResponse(records: any[], done = true, nextRecordsUrl?: string) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({
      totalSize: records.length,
      done,
      records,
      nextRecordsUrl,
    }),
  };
}

function createErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({ message: 'Error' }),
  };
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  mockAbort.mockReset();
});

// ---------------------------------------------------------------------------
// Tests: Successful query returns records
// ---------------------------------------------------------------------------

describe('queryRestApi', () => {
  it('should return records from a successful query', async () => {
    const records = [
      { Id: '001000000000001', Name: 'Admin' },
      { Id: '001000000000002', Name: 'Standard User' },
    ];
    mockFetch.mockResolvedValueOnce(createSuccessResponse(records));

    const result = await queryRestApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id, Name FROM Profile'
    );

    expect(result).toHaveLength(2);
    expect(result[0].Id).toBe('001000000000001');
    expect(result[1].Id).toBe('001000000000002');
  });

  it('should construct the correct REST API URL', async () => {
    mockFetch.mockResolvedValueOnce(createSuccessResponse([]));

    await queryRestApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id FROM Profile'
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT%20Id%20FROM%20Profile',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'Authorization': 'Bearer session123',
          'Content-Type': 'application/json',
        },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Tooling API uses correct URL path
// ---------------------------------------------------------------------------

describe('queryToolingApi', () => {
  it('should use the tooling API URL path', async () => {
    mockFetch.mockResolvedValueOnce(createSuccessResponse([]));

    await queryToolingApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id FROM ApexClass'
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://myorg.lightning.force.com/services/data/v59.0/tooling/query?q=SELECT%20Id%20FROM%20ApexClass',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'Authorization': 'Bearer session123',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  it('should return records from tooling API', async () => {
    const records = [{ Id: '01p000000000001', Name: 'MyClass' }];
    mockFetch.mockResolvedValueOnce(createSuccessResponse(records));

    const result = await queryToolingApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id, Name FROM ApexClass'
    );

    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('MyClass');
  });
});

// ---------------------------------------------------------------------------
// Tests: Pagination follows nextRecordsUrl up to max hops
// ---------------------------------------------------------------------------

describe('Pagination', () => {
  it('should follow nextRecordsUrl when done is false', async () => {
    const page1Records = [{ Id: '001', Name: 'Record1' }];
    const page2Records = [{ Id: '002', Name: 'Record2' }];

    mockFetch
      .mockResolvedValueOnce(createSuccessResponse(page1Records, false, '/services/data/v59.0/query/01g000000000001-2000'))
      .mockResolvedValueOnce(createSuccessResponse(page2Records, true));

    const result = await queryRestApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id, Name FROM Profile'
    );

    expect(result).toHaveLength(2);
    expect(result[0].Id).toBe('001');
    expect(result[1].Id).toBe('002');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should resolve nextRecordsUrl relative to instance URL', async () => {
    const page1Records = [{ Id: '001', Name: 'Record1' }];
    const page2Records = [{ Id: '002', Name: 'Record2' }];

    mockFetch
      .mockResolvedValueOnce(createSuccessResponse(page1Records, false, '/services/data/v59.0/query/locator-abc'))
      .mockResolvedValueOnce(createSuccessResponse(page2Records, true));

    await queryRestApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id FROM Profile'
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://myorg.lightning.force.com/services/data/v59.0/query/locator-abc',
      expect.anything()
    );
  });

  it('should stop after MAX_PAGINATION_HOPS (5) even if not done', async () => {
    // The loop starts with hops=0 and the initial URL counts as the first fetch inside the loop.
    // After each paginated fetch (where done=false), hops increments.
    // With MAX_PAGINATION_HOPS=5, we get initial fetch + up to 5 pagination hops = 6 total fetches max.
    // But actually: the initial fetch is at hops=0, and after it hops becomes 1.
    // So: hops 0->1, 1->2, 2->3, 3->4, 4->5 = 5 fetches, then hops=5 fails the while condition.
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(
        createSuccessResponse(
          [{ Id: `00${i}`, Name: `Record${i}` }],
          false,
          `/services/data/v59.0/query/page${i + 1}`
        )
      );
    }

    const result = await queryRestApi(
      'https://myorg.lightning.force.com',
      'session123',
      'SELECT Id, Name FROM Profile'
    );

    // Should have made exactly 5 calls (hops 0 through 4, then hops=5 exits)
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeout triggers error
// ---------------------------------------------------------------------------

describe('Timeout handling', () => {
  it('should throw ApiTimeoutError when fetch is aborted', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow(ApiTimeoutError);
  });

  it('should include descriptive message in ApiTimeoutError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow('API request timed out');
  });
});

// ---------------------------------------------------------------------------
// Tests: 401 response throws session expired error
// ---------------------------------------------------------------------------

describe('Error handling - 401', () => {
  it('should throw SessionExpiredError on 401 response', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(401));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'expired-session'
      )
    ).rejects.toThrow(SessionExpiredError);
  });

  it('should include session expired message', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(401));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'expired-session'
      )
    ).rejects.toThrow('Session expired');
  });
});

// ---------------------------------------------------------------------------
// Tests: 429 response throws rate limit error
// ---------------------------------------------------------------------------

describe('Error handling - 429', () => {
  it('should throw RateLimitError on 429 response', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(429));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow(RateLimitError);
  });

  it('should include rate limit message', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(429));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow('API limit reached');
  });
});

// ---------------------------------------------------------------------------
// Tests: 5xx response throws server error
// ---------------------------------------------------------------------------

describe('Error handling - 5xx', () => {
  it('should throw ServerError on 500 response', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(500));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow(ServerError);
  });

  it('should throw ServerError on 503 response', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(503));

    await expect(
      executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      )
    ).rejects.toThrow(ServerError);
  });

  it('should include status code in ServerError', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(502));

    try {
      await executeQuery(
        'https://myorg.lightning.force.com/services/data/v59.0/query?q=SELECT+Id+FROM+Profile',
        'session123'
      );
      fail('Expected ServerError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).statusCode).toBe(502);
    }
  });
});
