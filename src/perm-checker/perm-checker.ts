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
