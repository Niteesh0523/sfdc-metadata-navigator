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
  /**
   * False only when a field WAS selected but the FieldPermissions query
   * returned zero rows for it across every source, meaning the field isn't
   * FLS-governed at all (e.g. a standard/required field like Account.Name)
   * rather than genuinely inaccessible. True when no field was selected
   * (fieldRows === null) or when at least one source has a row for it.
   */
  fieldGoverned: boolean;
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
  /** Same value as EffectivePermissions.fieldGoverned — a property of the field, not the source. */
  fieldGoverned: boolean;
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
  // A field was checked but no source has ANY FieldPermissions row for it,
  // meaning the field isn't FLS-governed (e.g. Account.Name).
  const fieldGoverned = fieldRows === null || fieldRows.length > 0;

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
      fieldGoverned,
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
    fieldGoverned,
  };

  return { effective, bySource };
}
