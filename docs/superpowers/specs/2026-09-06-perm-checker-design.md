# Perm Checker — Design Spec

Date: 2026-09-06
Status: Approved for planning

## 1. Purpose

Add a diagnostic tool to the SFDC Metadata Navigator extension that answers
"does this User/Profile have access to this Object/Field, and why?" — the
question Plative consultants ask constantly while troubleshooting customer
access issues.

Two input modes:

1. **By User** — pick a User, pick an Object (and optionally a Field). Show
   the user's *effective* permission: their Profile's permission set OR'd
   with every directly-assigned Permission Set, plus a breakdown of which
   source granted what.
2. **By Profile** — pick a Profile, pick an Object (and optionally a Field).
   Show that Profile's own object-level (CRUD/ViewAll/ModifyAll) and
   field-level (Read/Edit) permissions directly, no aggregation.

## 2. Scope decisions (from brainstorming)

- **Permission Set Licenses**: informational only. For each non-profile
  Permission Set assigned to a user, if it requires a license
  (`PermissionSet.LicenseId != null`), show a badge with the license name and
  whether it's actually assigned to the user
  (`PermissionSetLicenseAssign WHERE AssigneeId = :userId`). PSLs do **not**
  themselves grant object/field permissions and are not folded into the
  effective-permission calculation.
- **Permission Set Groups / Muting Permission Sets**: out of scope for v1.
  Excluded from the query (`PermissionSetGroupId = null` filter) so the
  aggregation stays limited to Profile + directly-assigned Permission Sets.
  The UI must say so explicitly (see §5) to avoid implying false completeness.
- **Managed package objects/fields**: not excluded. Unlike the existing Apex
  scanner (which filters `NamespacePrefix = null`), permission checks are
  useful across all objects/fields including those from installed packages.

## 3. Key data-model insight

A Profile's permissions are stored internally as an ordinary `PermissionSet`
row: every Profile has a corresponding `PermissionSet` with
`ProfileId = <profile's id>` and `IsOwnedByProfile = true`. This means:

- **By Profile** mode = run the permission query against exactly one
  `PermissionSet` ID (the profile's own).
- **By User** mode = run the *same* permission query against the list of
  `PermissionSet` IDs the user has (their profile-owned one + directly
  assigned ones).

One query/aggregation function serves both modes; only the list of
`PermissionSet` IDs fed into it differs. This avoids two parallel code
paths for CRUD/FLS lookup.

## 4. Data flow

### 4.1 New background.ts message handlers

All follow the existing `getScannerSession()` → `fetchJson`/Tooling-query
pattern already used throughout `background.ts`.

| Action | Query | Returns |
|---|---|---|
| `searchUsers` | `SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE (Name LIKE '%q%' OR Username LIKE '%q%') AND IsActive = true ORDER BY Name LIMIT 20` | `{ users: [{id, name, username, profileId, profileName}] }` |
| `searchProfiles` | `SELECT Id, Name FROM Profile WHERE Name LIKE '%q%' ORDER BY Name LIMIT 20` | `{ profiles: [{id, name}] }` |
| `searchObjects` | `/sobjects` describe list (reuse/extend the existing `getKeyPrefixMap` cache), client-filtered by name substring | `{ objects: [{apiName, label}] }` |
| `searchFieldsForObject` | Reuses existing `handleGetAllFields` describe logic | `{ fields: [{apiName, label, type}] }` |
| `getUserPermissionSetIds` | `SELECT Id, PermissionSet.Id, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.LicenseId, PermissionSet.License.Name FROM PermissionSetAssignment WHERE AssigneeId = :userId AND PermissionSetGroupId = null` | List of `{permSetId, label, isOwnedByProfile, licenseId, licenseName}` |
| `getPermissionSetLicenseAssignments` | `SELECT PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = :userId` | Set of assigned license IDs, for the PSL badge |
| `getObjectAndFieldPermissions` | `SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId IN (:ids) AND SobjectType = :object`, plus (if a field was chosen) `SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (:ids) AND Field = 'Object.Field'` | Raw per-PermissionSet rows for both object and field perms |

`getObjectAndFieldPermissions` is the single shared query function used by
both modes; the caller just varies the `ids` list (one ID for Profile mode,
many for User mode).

### 4.2 Aggregation logic (pure function, unit-testable)

New module: `src/perm-checker/aggregate.ts`.

```
function aggregatePermissions(
  objectRows: ObjectPermissionRow[],
  fieldRows: FieldPermissionRow[] | null,
  sourceLabels: Map<permSetId, {label, isOwnedByProfile}>
): {
  effective: { create, read, edit, delete, viewAll, modifyAll, fieldRead?, fieldEdit? },
  bySource: Array<{ label, isProfile, create, read, edit, delete, viewAll, modifyAll, fieldRead?, fieldEdit? }>
}
```

`effective.*` is the logical OR across all rows in `bySource` for each
permission — this mirrors how Salesforce itself computes effective access
(any granting Profile or Permission Set is sufficient). No row present for
a given PermissionSet ID means all permissions default to `false` for that
source (this can legitimately happen for FieldPermissions rows that were
never explicitly toggled).

This is the one piece of real logic in the feature and gets dedicated unit
tests (see §7).

## 5. UI

New page: `src/perm-checker/perm-checker.html` / `.css` / `.ts`, opened from
a new "Perm Checker" link in the popup footer (`popup.html`/`popup.ts`),
wired the same way as `handleScannerClick`/`handleOrginfoClick`.

Layout:

- Two tabs at the top: **By User** / **By Profile**. Switching tabs clears
  the current result but keeps the Object/Field selection.
- A note under the "By User" tab: *"Checks Profile + directly assigned
  Permission Sets. Permission Set Groups and Muting Permission Sets are not
  yet included."*
- Entity search box (debounced input, live query via `searchUsers` /
  `searchProfiles` depending on the active tab) with a dropdown of matches;
  selecting one locks it in and shows it as a chip with an "×" to clear.
- Object search box (`searchObjects`), same select-and-chip pattern.
- Field search box (`searchFieldsForObject`, scoped to the selected object,
  disabled until an object is chosen), same pattern, **optional** — leaving
  it blank checks object-level permissions only.
- "Check Access" button, disabled until at least a User/Profile and an
  Object are selected.
- Results panel:
  - A CRUD/ViewAll/ModifyAll grid (and Read/Edit FLS row if a field was
    selected) showing the **effective** result per permission as a
    green/red badge, reusing the red/yellow/green visual language already
    established in `orginfo.ts`'s limit bars.
  - Below it, an expandable per-source table: one row per Profile/Permission
    Set with the same permission columns plus a PSL badge
    (`Requires: <License Name>` in green if assigned to the user, amber if
    not) — reusing the table markup pattern from `field-inspector.ts`'s
    `renderFlsPanel`.
  - In Profile mode, the per-source table always has exactly one row (the
    profile itself), shown without a PSL badge (profiles aren't
    license-gated).

## 6. Error handling

Reuses the existing categorized-error approach in `background.ts`
(`categorizeError`, `SessionExpiredError`, etc.) for any handler that hits
the Salesforce API. Empty search results (no matching user/object/field)
render as an inline "No matches" message under the relevant search box,
not a hard error.

## 7. Testing

- Unit tests for `aggregatePermissions` (the only real logic): OR-across-
  sources correctness, missing-row-defaults-to-false, field-permissions-
  omitted-when-no-field-selected, single-source (Profile mode) passthrough.
- Existing test patterns in `tests/background/` extended for the new
  message handlers where they contain non-trivial logic (e.g., filtering
  `PermissionSetGroupId = null`, PSL cross-referencing) — following the
  same style as `tests/background/index-builder.test.ts`.

## 8. Out of scope for v1

- Permission Set Groups and Muting Permission Sets.
- Any write/edit capability — this is read-only diagnostics.
- Caching results across sessions (each check is a fresh query; no index
  persistence needed since results are point-in-time by design).
