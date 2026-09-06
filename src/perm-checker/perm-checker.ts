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

document.addEventListener('DOMContentLoaded', init);
