# Perm Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Perm Checker" page to the SFDC Metadata Navigator extension that shows effective object/field permissions for a User (Profile + directly-assigned Permission Sets) or a Profile directly.

**Architecture:** A new pure aggregation module (`aggregate.ts`) computes effective Yes/No + per-source breakdown from raw permission rows. A new query module (`perm-queries.ts`) wraps the existing, already-mockable `queryRestApi` (from `src/background/api.ts`) with the SOQL this feature needs — this is what makes the feature's real logic unit-testable, unlike most of the existing `background.ts`, which calls `fetch` inline and has no tests for its newer handlers. `background.ts` gets thin new message handlers that call `getScannerSession()` (existing) then delegate to `perm-queries.ts`. A new full-page UI (`perm-checker.html/css/ts`) is opened from the popup footer, following the exact pattern of `scanner/` and `orginfo/`.

**Tech Stack:** TypeScript (strict), esbuild bundling (`scripts/build.js`), Jest + ts-jest for tests, Chrome Extension Manifest V3 APIs.

**Spec:** `docs/superpowers/specs/2026-09-06-perm-checker-design.md`

## Global Constraints

- No Permission Set Groups or Muting Permission Sets in v1 (spec §2) — the `getAssignedPermissionSets` query must filter `PermissionSetGroupId = null`.
- Permission Set Licenses are informational badges only, never folded into the effective-permission OR (spec §2).
- No managed-package filtering on objects/fields — unlike the Apex scanner, all objects/fields are checkable (spec §2).
- No new entries required in `manifest.json` — pages opened via `chrome.tabs.create(chrome.runtime.getURL(...))` from the popup/background don't need `web_accessible_resources` (confirmed: neither `orginfo.html` nor `scanner.html` appear there today).
- Read-only feature — no write/mutation of any Salesforce data (spec §8).
- Single quotes in any user-typed value going into SOQL must be escaped with `.replace(/'/g, "\\'")`, matching the existing convention throughout `background.ts`.

**Correction vs. the spec:** Spec §4.1 assumed `PermissionSetAssignment` includes a row for the user's Profile-owned `PermissionSet`. It does not — Salesforce only creates `PermissionSetAssignment` rows for directly-assigned Permission Sets. The profile-owned `PermissionSet` (the one with `IsOwnedByProfile = true`) must be resolved separately via `SELECT Id FROM PermissionSet WHERE ProfileId = :profileId`. This plan adds a `getProfilePermissionSetId` query to do that, used by both modes (the single ID for Profile mode; one of several IDs for User mode). Flagging this now since it changes the task list from what §4.1's table implies.

---

### Task 1: Aggregation types and pure `aggregatePermissions` function

**Files:**
- Create: `src/perm-checker/aggregate.ts`
- Test: `tests/perm-checker/aggregate.test.ts`

**Interfaces:**
- Produces (used by Tasks 2-4 and Task 8):
  ```typescript
  export interface ObjectPermissionRow {
    parentId: string;
    parentLabel: string;
    isOwnedByProfile: boolean;
    create: boolean;
    read: boolean;
    edit: boolean;
    delete: boolean;
    viewAll: boolean;
    modifyAll: boolean;
  }

  export interface FieldPermissionRow {
    parentId: string;
    read: boolean;
    edit: boolean;
  }

  export interface SourceMeta {
    label: string;
    isOwnedByProfile: boolean;
  }

  export interface EffectivePermissions {
    create: boolean;
    read: boolean;
    edit: boolean;
    delete: boolean;
    viewAll: boolean;
    modifyAll: boolean;
    fieldRead: boolean | null;
    fieldEdit: boolean | null;
  }

  export interface SourcePermissionResult {
    permissionSetId: string;
    label: string;
    isProfile: boolean;
    create: boolean;
    read: boolean;
    edit: boolean;
    delete: boolean;
    viewAll: boolean;
    modifyAll: boolean;
    fieldRead: boolean | null;
    fieldEdit: boolean | null;
  }

  export interface AggregatedPermissions {
    effective: EffectivePermissions;
    bySource: SourcePermissionResult[];
  }

  export function aggregatePermissions(
    permissionSetIds: string[],
    sourceMeta: Map<string, SourceMeta>,
    objectRows: ObjectPermissionRow[],
    fieldRows: FieldPermissionRow[] | null
  ): AggregatedPermissions;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/perm-checker/aggregate.test.ts`:

```typescript
import {
  aggregatePermissions,
  ObjectPermissionRow,
  FieldPermissionRow,
  SourceMeta,
} from '../../src/perm-checker/aggregate';

describe('aggregatePermissions', () => {
  it('ORs permissions across multiple sources (User mode)', () => {
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
      { parentId: 'ps2', parentLabel: 'Sales Extras', isOwnedByProfile: false, create: true, read: false, edit: true, delete: false, viewAll: false, modifyAll: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['ps1', { label: 'Profile: Standard', isOwnedByProfile: true }],
      ['ps2', { label: 'Sales Extras', isOwnedByProfile: false }],
    ]);

    const result = aggregatePermissions(['ps1', 'ps2'], sourceMeta, objectRows, null);

    expect(result.effective).toEqual({
      create: true,
      read: true,
      edit: true,
      delete: false,
      viewAll: false,
      modifyAll: false,
      fieldRead: null,
      fieldEdit: null,
    });
  });

  it('defaults a permission set with no matching row to all-false rather than throwing', () => {
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['ps1', { label: 'Profile: Standard', isOwnedByProfile: true }],
      ['ps2', { label: 'Empty Perm Set', isOwnedByProfile: false }],
    ]);

    const result = aggregatePermissions(['ps1', 'ps2'], sourceMeta, objectRows, null);

    const ps2Row = result.bySource.find(s => s.permissionSetId === 'ps2')!;
    expect(ps2Row).toEqual({
      permissionSetId: 'ps2',
      label: 'Empty Perm Set',
      isProfile: false,
      create: false,
      read: false,
      edit: false,
      delete: false,
      viewAll: false,
      modifyAll: false,
      fieldRead: null,
      fieldEdit: null,
    });
    // Effective read is still true because of ps1
    expect(result.effective.read).toBe(true);
  });

  it('omits field permissions entirely when fieldRows is null (object-only check)', () => {
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['ps1', { label: 'Profile: Standard', isOwnedByProfile: true }],
    ]);

    const result = aggregatePermissions(['ps1'], sourceMeta, objectRows, null);

    expect(result.effective.fieldRead).toBeNull();
    expect(result.effective.fieldEdit).toBeNull();
    expect(result.bySource[0].fieldRead).toBeNull();
    expect(result.bySource[0].fieldEdit).toBeNull();
  });

  it('passes through a single source unchanged (Profile mode)', () => {
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'profilePs', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: true, read: true, edit: true, delete: false, viewAll: false, modifyAll: false },
    ];
    const fieldRows: FieldPermissionRow[] = [
      { parentId: 'profilePs', read: true, edit: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['profilePs', { label: 'Profile: Standard', isOwnedByProfile: true }],
    ]);

    const result = aggregatePermissions(['profilePs'], sourceMeta, objectRows, fieldRows);

    expect(result.effective).toEqual({
      create: true,
      read: true,
      edit: true,
      delete: false,
      viewAll: false,
      modifyAll: false,
      fieldRead: true,
      fieldEdit: false,
    });
    expect(result.bySource).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/perm-checker/aggregate.test.ts`
Expected: FAIL — `Cannot find module '../../src/perm-checker/aggregate'`

- [ ] **Step 3: Write the implementation**

Create `src/perm-checker/aggregate.ts`:

```typescript
/**
 * SFDC Metadata Navigator - Permission Aggregation
 *
 * Pure logic that turns raw per-PermissionSet ObjectPermissions/FieldPermissions
 * rows into an effective (OR'd) result plus a per-source breakdown. Used by
 * both "By User" (multiple sources) and "By Profile" (single source) modes.
 */

export interface ObjectPermissionRow {
  parentId: string;
  parentLabel: string;
  isOwnedByProfile: boolean;
  create: boolean;
  read: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export interface FieldPermissionRow {
  parentId: string;
  read: boolean;
  edit: boolean;
}

export interface SourceMeta {
  label: string;
  isOwnedByProfile: boolean;
}

export interface EffectivePermissions {
  create: boolean;
  read: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
  fieldRead: boolean | null;
  fieldEdit: boolean | null;
}

export interface SourcePermissionResult {
  permissionSetId: string;
  label: string;
  isProfile: boolean;
  create: boolean;
  read: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
  fieldRead: boolean | null;
  fieldEdit: boolean | null;
}

export interface AggregatedPermissions {
  effective: EffectivePermissions;
  bySource: SourcePermissionResult[];
}

/**
 * Aggregates object/field permission rows across one or more PermissionSet IDs.
 * A PermissionSet ID with no matching row defaults to all-false for that source
 * (this happens legitimately when a permission was never explicitly toggled).
 * Pass `fieldRows: null` for an object-only check (no field selected).
 */
export function aggregatePermissions(
  permissionSetIds: string[],
  sourceMeta: Map<string, SourceMeta>,
  objectRows: ObjectPermissionRow[],
  fieldRows: FieldPermissionRow[] | null
): AggregatedPermissions {
  const objectByParent = new Map(objectRows.map(row => [row.parentId, row]));
  const fieldByParent = fieldRows ? new Map(fieldRows.map(row => [row.parentId, row])) : null;
  const checkingField = fieldByParent !== null;

  const bySource: SourcePermissionResult[] = permissionSetIds.map(id => {
    const meta = sourceMeta.get(id);
    const obj = objectByParent.get(id);
    const field = fieldByParent ? fieldByParent.get(id) : undefined;

    return {
      permissionSetId: id,
      label: meta?.label ?? id,
      isProfile: meta?.isOwnedByProfile ?? false,
      create: obj?.create ?? false,
      read: obj?.read ?? false,
      edit: obj?.edit ?? false,
      delete: obj?.delete ?? false,
      viewAll: obj?.viewAll ?? false,
      modifyAll: obj?.modifyAll ?? false,
      fieldRead: checkingField ? (field?.read ?? false) : null,
      fieldEdit: checkingField ? (field?.edit ?? false) : null,
    };
  });

  const effective: EffectivePermissions = {
    create: bySource.some(s => s.create),
    read: bySource.some(s => s.read),
    edit: bySource.some(s => s.edit),
    delete: bySource.some(s => s.delete),
    viewAll: bySource.some(s => s.viewAll),
    modifyAll: bySource.some(s => s.modifyAll),
    fieldRead: checkingField ? bySource.some(s => s.fieldRead === true) : null,
    fieldEdit: checkingField ? bySource.some(s => s.fieldEdit === true) : null,
  };

  return { effective, bySource };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/perm-checker/aggregate.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Type-check and commit**

Run: `npm run build:check`
Expected: no errors

```bash
git add src/perm-checker/aggregate.ts tests/perm-checker/aggregate.test.ts
git commit -m "feat: add permission aggregation logic for Perm Checker"
```

---

### Task 2: Query module — search users and profiles

**Files:**
- Create: `src/perm-checker/perm-queries.ts`
- Test: `tests/perm-checker/perm-queries.test.ts`

**Interfaces:**
- Consumes: `queryRestApi(instanceUrl: string, sessionId: string, soql: string): Promise<SalesforceRecord[]>` from `src/background/api.ts` (existing).
- Produces (used by Task 5 and Task 7):
  ```typescript
  export interface UserSearchResult {
    id: string;
    name: string;
    username: string;
    profileId: string;
    profileName: string;
  }
  export function searchUsers(instanceUrl: string, sessionId: string, query: string): Promise<UserSearchResult[]>;

  export interface ProfileSearchResult {
    id: string;
    name: string;
  }
  export function searchProfiles(instanceUrl: string, sessionId: string, query: string): Promise<ProfileSearchResult[]>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/perm-checker/perm-queries.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: FAIL — `Cannot find module '../../src/perm-checker/perm-queries'`

- [ ] **Step 3: Write the implementation**

Create `src/perm-checker/perm-queries.ts`:

```typescript
/**
 * SFDC Metadata Navigator - Perm Checker Query Module
 *
 * Wraps the existing queryRestApi() with the SOQL needed by the Perm Checker
 * feature. Kept separate from background.ts (which calls raw fetch inline for
 * most of its newer handlers) specifically so this logic is unit-testable by
 * mocking queryRestApi, the same way tests/background/index-builder.test.ts does.
 */

import { queryRestApi } from '../background/api';
import { ObjectPermissionRow, FieldPermissionRow } from './aggregate';

function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Entity Search
// ---------------------------------------------------------------------------

export interface UserSearchResult {
  id: string;
  name: string;
  username: string;
  profileId: string;
  profileName: string;
}

export async function searchUsers(
  instanceUrl: string,
  sessionId: string,
  query: string
): Promise<UserSearchResult[]> {
  const escaped = escapeSoqlString(query);
  const soql = `SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE (Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%') AND IsActive = true ORDER BY Name LIMIT 20`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({
    id: r.Id,
    name: r.Name,
    username: r.Username,
    profileId: r.ProfileId,
    profileName: r.Profile?.Name ?? '',
  }));
}

export interface ProfileSearchResult {
  id: string;
  name: string;
}

export async function searchProfiles(
  instanceUrl: string,
  sessionId: string,
  query: string
): Promise<ProfileSearchResult[]> {
  const escaped = escapeSoqlString(query);
  const soql = `SELECT Id, Name FROM Profile WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 20`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({ id: r.Id, name: r.Name }));
}
```

(This file grows in Tasks 3 and 4 — do not create a second file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/perm-checker/perm-queries.ts tests/perm-checker/perm-queries.test.ts
git commit -m "feat: add user/profile search queries for Perm Checker"
```

---

### Task 3: Query module — resolve Profile's PermissionSet and a user's assigned Permission Sets

**Files:**
- Modify: `src/perm-checker/perm-queries.ts`
- Modify: `tests/perm-checker/perm-queries.test.ts`

**Interfaces:**
- Produces (used by Task 7):
  ```typescript
  export function getProfilePermissionSetId(instanceUrl: string, sessionId: string, profileId: string): Promise<string | null>;

  export interface AssignedPermissionSet {
    permSetId: string;
    label: string;
    licenseId: string | null;
    licenseName: string | null;
  }
  export function getAssignedPermissionSets(instanceUrl: string, sessionId: string, userId: string): Promise<AssignedPermissionSet[]>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/perm-checker/perm-queries.test.ts`:

```typescript
import { getProfilePermissionSetId, getAssignedPermissionSets } from '../../src/perm-checker/perm-queries';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: FAIL — `getProfilePermissionSetId is not a function` / `getAssignedPermissionSets is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/perm-checker/perm-queries.ts`:

```typescript
// ---------------------------------------------------------------------------
// Permission Set Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the Id of the PermissionSet that Salesforce automatically creates
 * for a Profile (PermissionSet.ProfileId = profileId, IsOwnedByProfile = true).
 * This is NOT reachable via PermissionSetAssignment — it must be queried directly.
 */
export async function getProfilePermissionSetId(
  instanceUrl: string,
  sessionId: string,
  profileId: string
): Promise<string | null> {
  const escaped = escapeSoqlString(profileId);
  const soql = `SELECT Id FROM PermissionSet WHERE ProfileId = '${escaped}' LIMIT 1`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);
  return records.length > 0 ? (records[0] as any).Id : null;
}

export interface AssignedPermissionSet {
  permSetId: string;
  label: string;
  licenseId: string | null;
  licenseName: string | null;
}

/**
 * Returns the user's directly-assigned Permission Sets (excludes Permission Set
 * Group-derived assignments and the profile-owned Permission Set, which is
 * resolved separately via getProfilePermissionSetId). Permission Set Groups and
 * Muting Permission Sets are out of scope for v1 (see plan Global Constraints).
 */
export async function getAssignedPermissionSets(
  instanceUrl: string,
  sessionId: string,
  userId: string
): Promise<AssignedPermissionSet[]> {
  const escaped = escapeSoqlString(userId);
  const soql = `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.LicenseId, PermissionSet.License.Name FROM PermissionSetAssignment WHERE AssigneeId = '${escaped}' AND PermissionSetGroupId = null AND PermissionSet.IsOwnedByProfile = false`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({
    permSetId: r.PermissionSetId,
    label: r.PermissionSet?.Label ?? '',
    licenseId: r.PermissionSet?.LicenseId ?? null,
    licenseName: r.PermissionSet?.License?.Name ?? null,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: PASS (8 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/perm-checker/perm-queries.ts tests/perm-checker/perm-queries.test.ts
git commit -m "feat: resolve profile-owned and directly-assigned permission sets"
```

---

### Task 4: Query module — PSL assignments and object/field permission rows

**Files:**
- Modify: `src/perm-checker/perm-queries.ts`
- Modify: `tests/perm-checker/perm-queries.test.ts`

**Interfaces:**
- Consumes: `ObjectPermissionRow`, `FieldPermissionRow` from `./aggregate` (Task 1).
- Produces (used by Task 5 and Task 8):
  ```typescript
  export function getPermissionSetLicenseAssignments(instanceUrl: string, sessionId: string, userId: string): Promise<Set<string>>;

  export function getObjectAndFieldPermissions(
    instanceUrl: string,
    sessionId: string,
    permissionSetIds: string[],
    objectApiName: string,
    fieldApiName: string | null
  ): Promise<{ objectRows: ObjectPermissionRow[]; fieldRows: FieldPermissionRow[] | null }>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/perm-checker/perm-queries.test.ts`:

```typescript
import { getPermissionSetLicenseAssignments, getObjectAndFieldPermissions } from '../../src/perm-checker/perm-queries';

describe('getPermissionSetLicenseAssignments', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('returns a Set of assigned PermissionSetLicenseIds', async () => {
    mockedQueryRestApi.mockResolvedValue([
      { PermissionSetLicenseId: '1000000000001AAA' },
      { PermissionSetLicenseId: '1000000000002AAA' },
    ] as any);

    const result = await getPermissionSetLicenseAssignments('https://acme.my.salesforce.com', 'sess', '005000000000001');

    expect(result).toEqual(new Set(['1000000000001AAA', '1000000000002AAA']));
  });

  it('returns an empty Set when the user has no license assignments', async () => {
    mockedQueryRestApi.mockResolvedValue([]);

    const result = await getPermissionSetLicenseAssignments('https://acme.my.salesforce.com', 'sess', '005000000000001');

    expect(result.size).toBe(0);
  });
});

describe('getObjectAndFieldPermissions', () => {
  beforeEach(() => mockedQueryRestApi.mockReset());

  it('maps ObjectPermissions records to ObjectPermissionRow', async () => {
    mockedQueryRestApi.mockResolvedValueOnce([
      {
        ParentId: 'ps1', Parent: { Label: 'Profile: Standard', IsOwnedByProfile: true },
        PermissionsCreate: false, PermissionsRead: true, PermissionsEdit: false,
        PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false,
      },
    ] as any);

    const result = await getObjectAndFieldPermissions(
      'https://acme.my.salesforce.com', 'sess', ['ps1'], 'Account', null
    );

    expect(result.objectRows).toEqual([
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
    ]);
    expect(result.fieldRows).toBeNull();
    // Only the ObjectPermissions query should run when no field is given
    expect(mockedQueryRestApi).toHaveBeenCalledTimes(1);
  });

  it('also queries FieldPermissions when a field is given, scoped to Object.Field', async () => {
    mockedQueryRestApi
      .mockResolvedValueOnce([
        { ParentId: 'ps1', Parent: { Label: 'Profile: Standard', IsOwnedByProfile: true }, PermissionsCreate: false, PermissionsRead: true, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false },
      ] as any)
      .mockResolvedValueOnce([
        { ParentId: 'ps1', PermissionsRead: true, PermissionsEdit: false },
      ] as any);

    const result = await getObjectAndFieldPermissions(
      'https://acme.my.salesforce.com', 'sess', ['ps1'], 'Account', 'Industry'
    );

    expect(result.fieldRows).toEqual([{ parentId: 'ps1', read: true, edit: false }]);
    expect(mockedQueryRestApi).toHaveBeenCalledTimes(2);
    const fieldSoql = mockedQueryRestApi.mock.calls[1][2];
    expect(fieldSoql).toContain("Field = 'Account.Industry'");
  });

  it('builds the ParentId IN (...) clause from all provided PermissionSet IDs', async () => {
    mockedQueryRestApi.mockResolvedValue([]);

    await getObjectAndFieldPermissions('https://acme.my.salesforce.com', 'sess', ['ps1', 'ps2'], 'Account', null);

    const soql = mockedQueryRestApi.mock.calls[0][2];
    expect(soql).toContain("ParentId IN ('ps1','ps2')");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: FAIL — `getPermissionSetLicenseAssignments is not a function` / `getObjectAndFieldPermissions is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/perm-checker/perm-queries.ts`:

```typescript
// ---------------------------------------------------------------------------
// Permission Set License Assignments (informational only — see plan's Global Constraints)
// ---------------------------------------------------------------------------

export async function getPermissionSetLicenseAssignments(
  instanceUrl: string,
  sessionId: string,
  userId: string
): Promise<Set<string>> {
  const escaped = escapeSoqlString(userId);
  const soql = `SELECT PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = '${escaped}'`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);
  return new Set(records.map((r: any) => r.PermissionSetLicenseId as string));
}

// ---------------------------------------------------------------------------
// Object / Field Permissions
// ---------------------------------------------------------------------------

/**
 * Fetches raw ObjectPermissions rows for the given PermissionSet IDs, and
 * FieldPermissions rows too if fieldApiName is provided. Pass fieldApiName as
 * null for an object-level-only check (skips the FieldPermissions query).
 */
export async function getObjectAndFieldPermissions(
  instanceUrl: string,
  sessionId: string,
  permissionSetIds: string[],
  objectApiName: string,
  fieldApiName: string | null
): Promise<{ objectRows: ObjectPermissionRow[]; fieldRows: FieldPermissionRow[] | null }> {
  const idList = permissionSetIds.map(id => `'${escapeSoqlString(id)}'`).join(',');
  const escapedObject = escapeSoqlString(objectApiName);

  const objectSoql = `SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId IN (${idList}) AND SobjectType = '${escapedObject}'`;
  const objectRecords = await queryRestApi(instanceUrl, sessionId, objectSoql);

  const objectRows: ObjectPermissionRow[] = objectRecords.map((r: any) => ({
    parentId: r.ParentId,
    parentLabel: r.Parent?.Label ?? '',
    isOwnedByProfile: !!r.Parent?.IsOwnedByProfile,
    create: !!r.PermissionsCreate,
    read: !!r.PermissionsRead,
    edit: !!r.PermissionsEdit,
    delete: !!r.PermissionsDelete,
    viewAll: !!r.PermissionsViewAllRecords,
    modifyAll: !!r.PermissionsModifyAllRecords,
  }));

  if (!fieldApiName) {
    return { objectRows, fieldRows: null };
  }

  const escapedField = escapeSoqlString(`${objectApiName}.${fieldApiName}`);
  const fieldSoql = `SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${idList}) AND Field = '${escapedField}'`;
  const fieldRecords = await queryRestApi(instanceUrl, sessionId, fieldSoql);

  const fieldRows: FieldPermissionRow[] = fieldRecords.map((r: any) => ({
    parentId: r.ParentId,
    read: !!r.PermissionsRead,
    edit: !!r.PermissionsEdit,
  }));

  return { objectRows, fieldRows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/perm-checker/perm-queries.test.ts`
Expected: PASS (13 tests total)

- [ ] **Step 5: Type-check and commit**

Run: `npm run build:check`
Expected: no errors

```bash
git add src/perm-checker/perm-queries.ts tests/perm-checker/perm-queries.test.ts
git commit -m "feat: add PSL assignment and object/field permission queries"
```

---

### Task 5: Wire new message handlers into background.ts

**Files:**
- Modify: `src/background/background.ts`

**Interfaces:**
- Consumes: every function exported from `src/perm-checker/perm-queries.ts` (Tasks 2-4); existing `getScannerSession()` and `categorizeError()` already in this file; existing `handleGetAllFields()` already in this file (reused as-is for field search — no new handler needed for it).
- Produces (used by Task 7): new `chrome.runtime.onMessage` actions `searchUsers`, `searchProfiles`, `searchObjects`, `getProfilePermissionSetId`, `getAssignedPermissionSets`, `getPermissionSetLicenseAssignments`, `getObjectAndFieldPermissions`. Existing action `getAllFieldsForObject` is reused unchanged for field search.

No test file for this task — these handlers are thin glue (resolve session, delegate, catch/categorize), matching the existing untested convention for all of `background.ts`'s other thin handlers (e.g. `handleGetFieldPermissions`, `handleGetOrgInfoDashboard`). The real logic they call into is already unit-tested in Tasks 1-4.

- [ ] **Step 1: Add the import**

In `src/background/background.ts`, add near the top with the other imports (after the existing `import { runOrgScan } ...` line):

```typescript
import {
  searchUsers,
  searchProfiles,
  getProfilePermissionSetId,
  getAssignedPermissionSets,
  getPermissionSetLicenseAssignments,
  getObjectAndFieldPermissions,
} from '../perm-checker/perm-queries';
```

- [ ] **Step 2: Add the handler functions**

Insert these new functions after `handleGetFileTypeObjects` (right before the `getKeyPrefixMap` section, or any point after `getScannerSession` is defined — they call it):

```typescript
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
```

- [ ] **Step 3: Wire the actions into the message listener**

In `src/background/background.ts`, inside `chrome.runtime.onMessage.addListener(...)`, add these blocks right before the final `return false;`:

```typescript
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
```

- [ ] **Step 4: Type-check and run the full existing test suite**

Run: `npm run build:check`
Expected: no errors

Run: `npx jest tests/background`
Expected: PASS — existing background tests still pass unchanged (this task only adds new branches to the if-chain; it doesn't touch `refreshIndex`/`getSessionId`/`unknown action` behavior)

- [ ] **Step 5: Commit**

```bash
git add src/background/background.ts
git commit -m "feat: wire Perm Checker message handlers into background worker"
```

---

### Task 6: Perm Checker page markup and styles

**Files:**
- Create: `src/perm-checker/perm-checker.html`
- Create: `src/perm-checker/perm-checker.css`

**Interfaces:**
- Produces: DOM element IDs that Task 7/8's `perm-checker.ts` binds to (listed inline below).

No tests — static markup/styles, following the same untested convention as `orginfo.html`/`scanner.html`.

- [ ] **Step 1: Create the HTML**

Create `src/perm-checker/perm-checker.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perm Checker - SFDC Metadata Navigator</title>
  <link rel="stylesheet" href="perm-checker.css">
</head>
<body>
  <div class="pc-app">

    <header class="pc-header">
      <h1 class="header-title">Perm Checker</h1>
    </header>

    <div class="pc-tabs" role="tablist">
      <button id="tab-user" class="pc-tab active" type="button" role="tab" aria-selected="true">By User</button>
      <button id="tab-profile" class="pc-tab" type="button" role="tab" aria-selected="false">By Profile</button>
    </div>

    <p id="user-mode-note" class="pc-note">
      Checks Profile + directly assigned Permission Sets. Permission Set Groups and Muting Permission Sets are not yet included.
    </p>

    <section class="card pc-form">
      <div class="pc-field">
        <label id="entity-label" class="pc-label" for="entity-search-input">User</label>
        <div class="search-picker" id="entity-picker">
          <input id="entity-search-input" class="search-input" type="text" autocomplete="off" placeholder="Search by name...">
          <ul id="entity-dropdown" class="search-dropdown" hidden></ul>
          <div id="entity-chip" class="chip" hidden>
            <span id="entity-chip-label" class="chip-label"></span>
            <button id="entity-chip-remove" class="chip-remove" type="button" aria-label="Clear selection">&#10005;</button>
          </div>
        </div>
      </div>

      <div class="pc-field">
        <label class="pc-label" for="object-search-input">Object</label>
        <div class="search-picker" id="object-picker">
          <input id="object-search-input" class="search-input" type="text" autocomplete="off" placeholder="Search objects...">
          <ul id="object-dropdown" class="search-dropdown" hidden></ul>
          <div id="object-chip" class="chip" hidden>
            <span id="object-chip-label" class="chip-label"></span>
            <button id="object-chip-remove" class="chip-remove" type="button" aria-label="Clear selection">&#10005;</button>
          </div>
        </div>
      </div>

      <div class="pc-field">
        <label class="pc-label" for="field-search-input">Field <span class="pc-optional">(optional)</span></label>
        <div class="search-picker" id="field-picker">
          <input id="field-search-input" class="search-input" type="text" autocomplete="off" placeholder="Select an object first" disabled>
          <ul id="field-dropdown" class="search-dropdown" hidden></ul>
          <div id="field-chip" class="chip" hidden>
            <span id="field-chip-label" class="chip-label"></span>
            <button id="field-chip-remove" class="chip-remove" type="button" aria-label="Clear selection">&#10005;</button>
          </div>
        </div>
      </div>

      <button id="check-access-btn" class="btn btn-primary" type="button" disabled>Check Access</button>
    </section>

    <div id="loading-panel" class="loading-panel" hidden>
      <div class="spinner"></div>
      <p>Checking permissions...</p>
    </div>

    <div id="error-panel" class="error-panel" hidden>
      <span class="error-icon">&#9888;</span>
      <span id="error-text"></span>
    </div>

    <section id="results-panel" class="card" hidden>
      <h2 class="card-title">Effective Access</h2>
      <div id="effective-grid" class="perm-grid"></div>

      <button id="toggle-breakdown-btn" class="pc-toggle-breakdown" type="button">Show breakdown by source &#9662;</button>
      <div id="breakdown-table" class="source-table" hidden></div>
    </section>

  </div>

  <script src="perm-checker.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the CSS**

Create `src/perm-checker/perm-checker.css`:

```css
/* Perm Checker Styles */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1a1a1a;
  background: #f5f7fa;
  min-height: 100vh;
}

.pc-app {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px;
}

.pc-header {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.header-title {
  font-size: 22px;
  font-weight: 600;
}

/* Tabs */
.pc-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.pc-tab {
  border: none;
  background: none;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 500;
  color: #666;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.pc-tab.active {
  color: #1b96ff;
  border-bottom-color: #1b96ff;
}

.pc-note {
  font-size: 11px;
  color: #999;
  font-style: italic;
  margin-bottom: 16px;
}

.pc-note[hidden] { display: none; }

/* Cards (shared with orginfo.css visual language) */
.card {
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  padding: 20px 24px;
  margin-bottom: 16px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #333;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

/* Form */
.pc-form { display: flex; flex-direction: column; gap: 16px; }

.pc-field { display: flex; flex-direction: column; gap: 6px; }

.pc-label {
  font-size: 12px;
  font-weight: 600;
  color: #555;
}

.pc-optional {
  font-weight: 400;
  color: #999;
}

.btn {
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  padding: 9px 18px;
  transition: background 0.15s, opacity 0.15s;
  align-self: flex-start;
}

.btn-primary { background: #1b96ff; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #0d7de0; }
.btn-primary:disabled { background: #b8d9f7; cursor: not-allowed; }

/* Search picker */
.search-picker { position: relative; }

.search-input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid #d8d8d8;
  border-radius: 6px;
  font-size: 13px;
}

.search-input:disabled { background: #f5f5f5; color: #aaa; }

.search-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 220px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.12);
  z-index: 10;
  list-style: none;
}

.search-dropdown-item {
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

.search-dropdown-item:hover,
.search-dropdown-item.active {
  background: #f0f7ff;
}

.search-dropdown-empty {
  padding: 8px 12px;
  font-size: 12px;
  color: #999;
}

/* Chip */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #eef6ff;
  border: 1px solid #c4dcf5;
  border-radius: 20px;
  padding: 6px 8px 6px 14px;
  font-size: 13px;
  color: #0d5fb8;
}

.chip-remove {
  border: none;
  background: rgba(13,95,184,0.1);
  color: #0d5fb8;
  border-radius: 50%;
  width: 18px;
  height: 18px;
  font-size: 10px;
  cursor: pointer;
}

/* Loading / Error (shared visual language with orginfo.css) */
.loading-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px;
  text-align: center;
  color: #666;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 4px solid #e0e0e0;
  border-top-color: #1b96ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin { to { transform: rotate(360deg); } }

.error-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #dc2626;
  font-size: 13px;
}

/* Effective permission grid */
.perm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.perm-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 6px;
  background: #fafafa;
  border: 1px solid #eee;
  font-size: 12px;
}

.perm-yes, .perm-no, .perm-na {
  font-weight: 600;
  font-size: 12px;
}

.perm-yes { color: #27ae60; }
.perm-no { color: #e74c3c; }
.perm-na { color: #ccc; }

/* Per-source breakdown table */
.pc-toggle-breakdown {
  border: none;
  background: none;
  color: #1b96ff;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
}

.source-table {
  margin-top: 12px;
  border-top: 1px solid #eee;
  padding-top: 12px;
}

.source-row {
  display: grid;
  grid-template-columns: 1.6fr repeat(6, 0.6fr);
  gap: 6px;
  align-items: center;
  padding: 8px 4px;
  font-size: 12px;
  border-bottom: 1px solid #f5f5f5;
}

.source-row-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: #999;
  border-bottom: 1px solid #eee;
}

.source-name { display: flex; flex-direction: column; gap: 2px; }

.profile-badge {
  display: inline-block;
  background: #e3f2fd;
  color: #1565c0;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
  width: fit-content;
}

.license-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 9px;
  width: fit-content;
}

.license-badge.assigned { background: #e8f5e9; color: #2e7d32; }
.license-badge.missing { background: #fff8e1; color: #b8860b; }
```

- [ ] **Step 3: Commit**

```bash
git add src/perm-checker/perm-checker.html src/perm-checker/perm-checker.css
git commit -m "feat: add Perm Checker page markup and styles"
```

---

### Task 7: Perm Checker UI — tabs and search-picker behavior

**Files:**
- Create: `src/perm-checker/perm-checker.ts`

**Interfaces:**
- Consumes: DOM element IDs from Task 6's HTML.
- Produces: this task builds the reusable `SearchPicker` class and mode/tab state; Task 8 adds the `runCheck()`/rendering logic to the same file.

No tests — DOM-wiring UI code, matching the existing untested convention for `orginfo.ts`/`scanner-ui.ts`/`field-inspector.ts`.

- [ ] **Step 1: Create the file with tabs, state, and the reusable search picker**

Create `src/perm-checker/perm-checker.ts`:

```typescript
/**
 * SFDC Metadata Navigator - Perm Checker Controller
 *
 * Two modes (By User / By Profile) share the same Object/Field pickers and
 * results rendering. See aggregate.ts for how the effective result is computed
 * from the raw rows this page fetches via background.ts message handlers.
 */

import {
  aggregatePermissions,
  AggregatedPermissions,
  SourceMeta,
} from './aggregate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = 'user' | 'profile';

interface PickedItem {
  id: string;
  label: string;
  // Only populated for a picked User (mode = 'user')
  profileId?: string;
  profileName?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mode: Mode = 'user';
let pickedEntity: PickedItem | null = null;
let pickedObject: PickedItem | null = null;
let pickedField: PickedItem | null = null;

let entityPicker: SearchPicker;
let objectPicker: SearchPicker;
let fieldPicker: SearchPicker;

// ---------------------------------------------------------------------------
// Reusable Search Picker
// ---------------------------------------------------------------------------

interface SearchPickerOptions {
  inputEl: HTMLInputElement;
  dropdownEl: HTMLUListElement;
  chipEl: HTMLElement;
  chipLabelEl: HTMLElement;
  chipRemoveEl: HTMLButtonElement;
  /** Returns the items to show for a given query. */
  search: (query: string) => Promise<PickedItem[]>;
  onSelect: (item: PickedItem) => void;
  onClear: () => void;
  debounceMs?: number;
}

/**
 * A debounced search-as-you-type input that renders a dropdown of matches and,
 * once one is selected, replaces the input with a removable chip. Used for the
 * entity (User/Profile), Object, and Field pickers — same behavior, different
 * data source.
 */
class SearchPicker {
  private opts: SearchPickerOptions;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SearchPickerOptions) {
    this.opts = opts;
    this.opts.inputEl.addEventListener('input', () => this.handleInput());
    this.opts.chipRemoveEl.addEventListener('click', () => this.clear());
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest(`#${this.opts.inputEl.id}, #${this.opts.dropdownEl.id}`)) {
        this.closeDropdown();
      }
    });
  }

  private handleInput(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const query = this.opts.inputEl.value.trim();
    if (query.length === 0) {
      this.closeDropdown();
      return;
    }
    this.debounceTimer = setTimeout(() => this.runSearch(query), this.opts.debounceMs ?? 250);
  }

  private async runSearch(query: string): Promise<void> {
    const results = await this.opts.search(query);
    this.renderDropdown(results);
  }

  private renderDropdown(items: PickedItem[]): void {
    const { dropdownEl } = this.opts;
    dropdownEl.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'search-dropdown-empty';
      empty.textContent = 'No matches';
      dropdownEl.appendChild(empty);
      dropdownEl.hidden = false;
      return;
    }

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'search-dropdown-item';
      li.textContent = item.label;
      li.addEventListener('click', () => this.select(item));
      dropdownEl.appendChild(li);
    }
    dropdownEl.hidden = false;
  }

  private select(item: PickedItem): void {
    this.closeDropdown();
    this.opts.inputEl.value = '';
    this.opts.inputEl.hidden = true;
    this.opts.chipLabelEl.textContent = item.label;
    this.opts.chipEl.hidden = false;
    this.opts.onSelect(item);
  }

  clear(): void {
    this.opts.chipEl.hidden = true;
    this.opts.inputEl.hidden = false;
    this.opts.inputEl.value = '';
    this.opts.onClear();
  }

  /** Disables/enables the input (used for the Field picker until an Object is chosen). */
  setEnabled(enabled: boolean): void {
    this.opts.inputEl.disabled = !enabled;
    this.opts.inputEl.placeholder = enabled ? 'Search fields...' : 'Select an object first';
  }

  private closeDropdown(): void {
    this.opts.dropdownEl.hidden = true;
    this.opts.dropdownEl.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// Messaging Helper
// ---------------------------------------------------------------------------

function sendMessage(message: unknown): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  const tabUser = document.getElementById('tab-user') as HTMLButtonElement;
  const tabProfile = document.getElementById('tab-profile') as HTMLButtonElement;
  tabUser.addEventListener('click', () => setMode('user'));
  tabProfile.addEventListener('click', () => setMode('profile'));

  entityPicker = new SearchPicker({
    inputEl: document.getElementById('entity-search-input') as HTMLInputElement,
    dropdownEl: document.getElementById('entity-dropdown') as HTMLUListElement,
    chipEl: document.getElementById('entity-chip')!,
    chipLabelEl: document.getElementById('entity-chip-label')!,
    chipRemoveEl: document.getElementById('entity-chip-remove') as HTMLButtonElement,
    search: async (query) => {
      const action = mode === 'user' ? 'searchUsers' : 'searchProfiles';
      const response = await sendMessage({ action, query });
      if (mode === 'user') {
        return (response?.users || []).map((u: any) => ({
          id: u.id, label: `${u.name} (${u.username})`, profileId: u.profileId, profileName: u.profileName,
        }));
      }
      return (response?.profiles || []).map((p: any) => ({ id: p.id, label: p.name }));
    },
    onSelect: (item) => { pickedEntity = item; updateCheckButtonState(); },
    onClear: () => { pickedEntity = null; updateCheckButtonState(); },
  });

  objectPicker = new SearchPicker({
    inputEl: document.getElementById('object-search-input') as HTMLInputElement,
    dropdownEl: document.getElementById('object-dropdown') as HTMLUListElement,
    chipEl: document.getElementById('object-chip')!,
    chipLabelEl: document.getElementById('object-chip-label')!,
    chipRemoveEl: document.getElementById('object-chip-remove') as HTMLButtonElement,
    search: async (query) => {
      const response = await sendMessage({ action: 'searchObjects', query });
      return (response?.objects || []).map((o: any) => ({ id: o.apiName, label: `${o.label} (${o.apiName})` }));
    },
    onSelect: (item) => {
      pickedObject = item;
      pickedField = null;
      fieldPicker.clear();
      fieldPicker.setEnabled(true);
      updateCheckButtonState();
    },
    onClear: () => {
      pickedObject = null;
      pickedField = null;
      fieldPicker.clear();
      fieldPicker.setEnabled(false);
      updateCheckButtonState();
    },
  });

  fieldPicker = new SearchPicker({
    inputEl: document.getElementById('field-search-input') as HTMLInputElement,
    dropdownEl: document.getElementById('field-dropdown') as HTMLUListElement,
    chipEl: document.getElementById('field-chip')!,
    chipLabelEl: document.getElementById('field-chip-label')!,
    chipRemoveEl: document.getElementById('field-chip-remove') as HTMLButtonElement,
    search: async (query) => {
      if (!pickedObject) return [];
      const response = await sendMessage({ action: 'getAllFieldsForObject', objectName: pickedObject.id });
      const lowerQuery = query.toLowerCase();
      return (response?.fields || [])
        .filter((f: any) => f.apiName.toLowerCase().includes(lowerQuery) || f.label.toLowerCase().includes(lowerQuery))
        .slice(0, 20)
        .map((f: any) => ({ id: f.apiName, label: `${f.label} (${f.apiName})` }));
    },
    onSelect: (item) => { pickedField = item; },
    onClear: () => { pickedField = null; },
  });
  fieldPicker.setEnabled(false);

  document.getElementById('check-access-btn')!.addEventListener('click', () => runCheck());
}

function setMode(newMode: Mode): void {
  if (mode === newMode) return;
  mode = newMode;

  document.getElementById('tab-user')!.classList.toggle('active', newMode === 'user');
  document.getElementById('tab-profile')!.classList.toggle('active', newMode === 'profile');
  document.getElementById('tab-user')!.setAttribute('aria-selected', String(newMode === 'user'));
  document.getElementById('tab-profile')!.setAttribute('aria-selected', String(newMode === 'profile'));
  document.getElementById('user-mode-note')!.hidden = newMode !== 'user';
  document.getElementById('entity-label')!.textContent = newMode === 'user' ? 'User' : 'Profile';

  // Switching modes invalidates the picked entity (different search source);
  // Object/Field selections are preserved per the design.
  entityPicker.clear();
  pickedEntity = null;
  document.getElementById('results-panel')!.hidden = true;
  updateCheckButtonState();
}

function updateCheckButtonState(): void {
  const btn = document.getElementById('check-access-btn') as HTMLButtonElement;
  btn.disabled = !(pickedEntity && pickedObject);
}

document.addEventListener('DOMContentLoaded', init);
```

Note: `runCheck()` is referenced but not yet defined — Task 8 adds it to this same file. `npm run build:check` will fail until Task 8 is complete; that's expected mid-task-sequence and is resolved by the next task.

- [ ] **Step 2: Commit**

```bash
git add src/perm-checker/perm-checker.ts
git commit -m "feat: add Perm Checker tab switching and search-picker UI"
```

---

### Task 8: Perm Checker UI — Check Access flow and results rendering

**Files:**
- Modify: `src/perm-checker/perm-checker.ts`

**Interfaces:**
- Consumes: `aggregatePermissions`, `AggregatedPermissions`, `SourceMeta` from `./aggregate` (Task 1); the seven message actions from Task 5; `PickedItem`, `pickedEntity`/`pickedObject`/`pickedField`/`mode` state from Task 7.

No tests — DOM-rendering code, same convention as Task 7.

- [ ] **Step 1: Append the Check Access flow and rendering functions**

Append to `src/perm-checker/perm-checker.ts` (before the final `document.addEventListener('DOMContentLoaded', init);` line — move that line to stay last in the file):

```typescript
// ---------------------------------------------------------------------------
// Check Access
// ---------------------------------------------------------------------------

async function runCheck(): Promise<void> {
  if (!pickedEntity || !pickedObject) return;

  setLoading(true);
  document.getElementById('error-panel')!.hidden = true;
  document.getElementById('results-panel')!.hidden = true;

  try {
    const permissionSetIds: string[] = [];
    const sourceMeta = new Map<string, SourceMeta>();
    const licenseBadges = new Map<string, { licenseName: string; assigned: boolean }>();

    if (mode === 'profile') {
      const profileResp = await sendMessage({ action: 'getProfilePermissionSetId', profileId: pickedEntity.id });
      if (profileResp?.error) { showError(profileResp.error); return; }
      if (!profileResp?.permSetId) { showError("Could not resolve this Profile's permission set."); return; }

      permissionSetIds.push(profileResp.permSetId);
      sourceMeta.set(profileResp.permSetId, { label: pickedEntity.label, isOwnedByProfile: true });
    } else {
      const [profileResp, assignedResp, licenseResp] = await Promise.all([
        sendMessage({ action: 'getProfilePermissionSetId', profileId: pickedEntity.profileId }),
        sendMessage({ action: 'getAssignedPermissionSets', userId: pickedEntity.id }),
        sendMessage({ action: 'getPermissionSetLicenseAssignments', userId: pickedEntity.id }),
      ]);

      if (profileResp?.error) { showError(profileResp.error); return; }
      if (assignedResp?.error) { showError(assignedResp.error); return; }

      const assignedLicenseIds = new Set<string>(licenseResp?.licenseIds || []);

      if (profileResp?.permSetId) {
        permissionSetIds.push(profileResp.permSetId);
        sourceMeta.set(profileResp.permSetId, { label: `Profile: ${pickedEntity.profileName}`, isOwnedByProfile: true });
      }

      for (const ps of (assignedResp?.permissionSets || [])) {
        permissionSetIds.push(ps.permSetId);
        sourceMeta.set(ps.permSetId, { label: ps.label, isOwnedByProfile: false });
        if (ps.licenseId) {
          licenseBadges.set(ps.permSetId, {
            licenseName: ps.licenseName || 'Unknown License',
            assigned: assignedLicenseIds.has(ps.licenseId),
          });
        }
      }
    }

    if (permissionSetIds.length === 0) {
      showError('No Profile or Permission Set found for this selection.');
      return;
    }

    const permsResp = await sendMessage({
      action: 'getObjectAndFieldPermissions',
      permissionSetIds,
      objectApiName: pickedObject.id,
      fieldApiName: pickedField ? pickedField.id : null,
    });

    if (permsResp?.error) { showError(permsResp.error); return; }

    const result = aggregatePermissions(permissionSetIds, sourceMeta, permsResp.objectRows, permsResp.fieldRows);
    renderResults(result, licenseBadges);
  } catch (e: unknown) {
    showError(e instanceof Error ? e.message : 'Failed to check permissions.');
  } finally {
    setLoading(false);
  }
}

function setLoading(loading: boolean): void {
  document.getElementById('loading-panel')!.hidden = !loading;
  (document.getElementById('check-access-btn') as HTMLButtonElement).disabled = loading || !(pickedEntity && pickedObject);
}

function showError(message: string): void {
  const panel = document.getElementById('error-panel')!;
  document.getElementById('error-text')!.textContent = message;
  panel.hidden = false;
}

// ---------------------------------------------------------------------------
// Results Rendering
// ---------------------------------------------------------------------------

function permBadge(value: boolean | null): string {
  if (value === null) return '<span class="perm-na">N/A</span>';
  return value ? '<span class="perm-yes">&#10003; Yes</span>' : '<span class="perm-no">&#10007; No</span>';
}

const PERM_LABELS: Array<{ key: 'create' | 'read' | 'edit' | 'delete' | 'viewAll' | 'modifyAll'; label: string }> = [
  { key: 'create', label: 'Create' },
  { key: 'read', label: 'Read' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
  { key: 'viewAll', label: 'View All' },
  { key: 'modifyAll', label: 'Modify All' },
];

function renderResults(
  result: AggregatedPermissions,
  licenseBadges: Map<string, { licenseName: string; assigned: boolean }>
): void {
  const grid = document.getElementById('effective-grid')!;
  grid.innerHTML = '';

  for (const { key, label } of PERM_LABELS) {
    const cell = document.createElement('div');
    cell.className = 'perm-cell';
    cell.innerHTML = `<span>${label}</span>${permBadge(result.effective[key])}`;
    grid.appendChild(cell);
  }

  if (result.effective.fieldRead !== null) {
    const readCell = document.createElement('div');
    readCell.className = 'perm-cell';
    readCell.innerHTML = `<span>Field Read</span>${permBadge(result.effective.fieldRead)}`;
    grid.appendChild(readCell);

    const editCell = document.createElement('div');
    editCell.className = 'perm-cell';
    editCell.innerHTML = `<span>Field Edit</span>${permBadge(result.effective.fieldEdit)}`;
    grid.appendChild(editCell);
  }

  renderBreakdown(result, licenseBadges);

  document.getElementById('results-panel')!.hidden = false;
}

function renderBreakdown(
  result: AggregatedPermissions,
  licenseBadges: Map<string, { licenseName: string; assigned: boolean }>
): void {
  const container = document.getElementById('breakdown-table')!;
  container.innerHTML = '';

  const showFieldCols = result.effective.fieldRead !== null;
  const colCount = showFieldCols ? 8 : 6;

  const header = document.createElement('div');
  header.className = 'source-row source-row-header';
  header.style.gridTemplateColumns = `1.6fr repeat(${colCount}, 0.6fr)`;
  header.innerHTML = `<span>Source</span><span>Create</span><span>Read</span><span>Edit</span><span>Delete</span><span>View All</span><span>Modify All</span>${showFieldCols ? '<span>F.Read</span><span>F.Edit</span>' : ''}`;
  container.appendChild(header);

  for (const source of result.bySource) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.style.gridTemplateColumns = `1.6fr repeat(${colCount}, 0.6fr)`;

    const license = licenseBadges.get(source.permissionSetId);
    const licenseHtml = license
      ? `<span class="license-badge ${license.assigned ? 'assigned' : 'missing'}">${escapeHtml(license.licenseName)}${license.assigned ? '' : ' (not assigned)'}</span>`
      : '';
    const profileBadgeHtml = source.isProfile ? '<span class="profile-badge">Profile</span>' : '';

    row.innerHTML = `
      <span class="source-name">${escapeHtml(source.label)}${profileBadgeHtml}${licenseHtml}</span>
      ${permBadge(source.create)}
      ${permBadge(source.read)}
      ${permBadge(source.edit)}
      ${permBadge(source.delete)}
      ${permBadge(source.viewAll)}
      ${permBadge(source.modifyAll)}
      ${showFieldCols ? permBadge(source.fieldRead) : ''}
      ${showFieldCols ? permBadge(source.fieldEdit) : ''}
    `;
    container.appendChild(row);
  }

  const toggleBtn = document.getElementById('toggle-breakdown-btn')!;
  toggleBtn.onclick = () => {
    const isHidden = container.hidden;
    container.hidden = !isHidden;
    toggleBtn.textContent = isHidden ? 'Hide breakdown by source ▴' : 'Show breakdown by source ▾';
  };
  container.hidden = true;
  toggleBtn.textContent = 'Show breakdown by source ▾';
}

function escapeHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build:check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/perm-checker/perm-checker.ts
git commit -m "feat: add Perm Checker results rendering and Check Access flow"
```

---

### Task 9: Wire the popup footer link

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.ts`

**Interfaces:**
- Produces: clicking "Perm Checker" in the popup footer opens `perm-checker.html` in a new tab, exactly like the existing Scanner/Org Info links.

No tests — this mirrors `handleScannerClick`/`handleOrginfoClick`, which are untested.

- [ ] **Step 1: Add the footer link**

In `src/popup/popup.html`, add a new link inside `.popup-footer`, after the existing `scanner-link` anchor:

```html
        <a id="perm-checker-link" class="settings-link" href="#" title="Check user/profile permissions">
          <span class="settings-icon">&#128274;</span> Perm Checker
        </a>
```

- [ ] **Step 2: Wire the click handler**

In `src/popup/popup.ts`:

Add to the DOM element variable declarations (near `let scannerLink: HTMLElement;`):

```typescript
let permCheckerLink: HTMLElement;
```

Add to `init()`, near `scannerLink = document.getElementById('scanner-link')!;`:

```typescript
  permCheckerLink = document.getElementById('perm-checker-link')!;
```

Add to `init()`, near `scannerLink.addEventListener('click', handleScannerClick);`:

```typescript
  permCheckerLink.addEventListener('click', handlePermCheckerClick);
```

Add the handler function near `handleScannerClick`:

```typescript
/**
 * Opens the Perm Checker page in a new tab.
 */
function handlePermCheckerClick(event: Event): void {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('perm-checker/perm-checker.html') });
}
```

- [ ] **Step 3: Type-check**

Run: `npm run build:check`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html src/popup/popup.ts
git commit -m "feat: add Perm Checker link to popup footer"
```

---

### Task 10: Bundle Perm Checker in the build and verify the extension loads

**Files:**
- Modify: `scripts/build.js`

**Interfaces:**
- None — this is the final packaging step; there's nothing later in this plan that depends on it, but it's required for the feature to actually run in Chrome.

No automated test — verified by running the build and doing a manual smoke check per Step 3.

- [ ] **Step 1: Add the esbuild entry point**

In `scripts/build.js`, inside `bundleEntryPoints()`, add after the "Field Inspector script" block:

```javascript
  // Perm Checker script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/perm-checker/perm-checker.ts')],
    outfile: path.join(BUILD_DIR, 'perm-checker/perm-checker.js'),
  });
```

- [ ] **Step 2: Add the static asset copy step**

In `scripts/build.js`, inside `copyStaticAssets()`, add after the "Org Info HTML and CSS" block:

```javascript
  // Perm Checker HTML and CSS
  const permCheckerDir = path.join(BUILD_DIR, 'perm-checker');
  fs.mkdirSync(permCheckerDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/perm-checker/perm-checker.html'),
    path.join(permCheckerDir, 'perm-checker.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/perm-checker/perm-checker.css'),
    path.join(permCheckerDir, 'perm-checker.css')
  );
```

- [ ] **Step 3: Run the full build and test suite**

Run: `npm run build`
Expected: `Build complete! Extension ready at: <path>/build`, with no esbuild errors. Confirm `build/perm-checker/perm-checker.html`, `build/perm-checker/perm-checker.css`, and `build/perm-checker/perm-checker.js` all exist.

Run: `npm test`
Expected: all tests pass, including the 17 new tests from Tasks 1-4.

Run: `npm run build:check`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Load `build/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked), open a Salesforce org tab, click the extension icon, click "Perm Checker" in the footer, and confirm the new tab opens with the By User / By Profile tabs, search pickers, and a disabled "Check Access" button. Search for a real user and a real object, select both, click "Check Access", and confirm the effective grid and breakdown table render without console errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/build.js
git commit -m "feat: bundle Perm Checker into the extension build"
```

---

## Summary of new files

- `src/perm-checker/aggregate.ts` — pure permission aggregation (unit tested)
- `src/perm-checker/perm-queries.ts` — SOQL query wrappers (unit tested)
- `src/perm-checker/perm-checker.html`
- `src/perm-checker/perm-checker.css`
- `src/perm-checker/perm-checker.ts` — UI controller
- `tests/perm-checker/aggregate.test.ts`
- `tests/perm-checker/perm-queries.test.ts`

## Summary of modified files

- `src/background/background.ts` — 7 new message handlers
- `src/popup/popup.html`, `src/popup/popup.ts` — new footer link
- `scripts/build.js` — new bundle entry + static asset copy
