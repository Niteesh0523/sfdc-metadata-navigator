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
      fieldGoverned: true,
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
      fieldGoverned: true,
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
    // fieldGoverned is still true when no field was checked at all — its
    // value doesn't matter for rendering in this case (gated off by
    // fieldRead !== null), but it should be correct/consistent regardless.
    expect(result.effective.fieldGoverned).toBe(true);
    expect(result.bySource[0].fieldGoverned).toBe(true);
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
      fieldGoverned: true,
    });
    expect(result.bySource).toHaveLength(1);
  });

  it('marks a field as not FLS-governed when a field was checked but no source has a FieldPermissions row', () => {
    // e.g. checking a standard/required field like Account.Name, which Salesforce
    // never allows FLS on: the FieldPermissions query returns zero rows for it,
    // for every source, even though the field itself was selected.
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['ps1', { label: 'Profile: Standard', isOwnedByProfile: true }],
    ]);

    const result = aggregatePermissions(['ps1'], sourceMeta, objectRows, []);

    expect(result.effective.fieldGoverned).toBe(false);
    expect(result.bySource[0].fieldGoverned).toBe(false);
    // fieldRead/fieldEdit are still computed as before (false, since no
    // source has a row) — the caller must consult fieldGoverned to know
    // this isn't a real "No".
    expect(result.effective.fieldRead).toBe(false);
    expect(result.effective.fieldEdit).toBe(false);
    expect(result.bySource[0].fieldRead).toBe(false);
    expect(result.bySource[0].fieldEdit).toBe(false);
  });

  it('marks a field as FLS-governed when at least one source has a FieldPermissions row', () => {
    const objectRows: ObjectPermissionRow[] = [
      { parentId: 'ps1', parentLabel: 'Profile: Standard', isOwnedByProfile: true, create: false, read: true, edit: false, delete: false, viewAll: false, modifyAll: false },
    ];
    const fieldRows: FieldPermissionRow[] = [
      { parentId: 'ps1', read: true, edit: false },
    ];
    const sourceMeta = new Map<string, SourceMeta>([
      ['ps1', { label: 'Profile: Standard', isOwnedByProfile: true }],
    ]);

    const result = aggregatePermissions(['ps1'], sourceMeta, objectRows, fieldRows);

    expect(result.effective.fieldGoverned).toBe(true);
    expect(result.bySource[0].fieldGoverned).toBe(true);
  });
});
