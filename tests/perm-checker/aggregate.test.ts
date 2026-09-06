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
