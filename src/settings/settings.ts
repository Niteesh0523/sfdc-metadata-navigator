/**
 * SFDC Metadata Navigator - Settings Persistence Logic
 *
 * Manages loading and saving user settings (enabled metadata types)
 * using Chrome sync storage with fallback to local storage.
 */

import { MetadataType, UserSettings } from '../shared/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY, ALL_METADATA_TYPES } from '../shared/constants';

// ---------------------------------------------------------------------------
// Settings Persistence
// ---------------------------------------------------------------------------

/**
 * Loads user settings from Chrome sync storage.
 * Falls back to Chrome local storage if sync is unavailable.
 * Returns default settings if neither storage contains saved settings.
 */
export async function loadSettings(): Promise<UserSettings> {
  // Try sync storage first
  try {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      return result[SETTINGS_KEY] as UserSettings;
    }
  } catch {
    // Sync storage unavailable — try local fallback
  }

  // Fallback: try local storage
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      return result[SETTINGS_KEY] as UserSettings;
    }
  } catch {
    // Local storage also unavailable
  }

  return DEFAULT_SETTINGS;
}

/**
 * Saves user settings to Chrome sync storage.
 * Falls back to Chrome local storage if sync storage write fails.
 *
 * @param settings - The UserSettings object to persist
 * @throws Error if both sync and local storage writes fail
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
  // Try sync storage first
  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    return;
  } catch {
    // Sync storage write failed — fall back to local
  }

  // Fallback: save to local storage
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---------------------------------------------------------------------------
// Settings Page Controller
// ---------------------------------------------------------------------------

/**
 * Mapping of MetadataType to checkbox element IDs in settings.html.
 */
const TYPE_TO_CHECKBOX_ID: Record<MetadataType, string> = {
  Profile: 'type-profile',
  PermissionSet: 'type-permissionset',
  Flow: 'type-flow',
  EmailTemplate: 'type-emailtemplate',
  Layout: 'type-layout',
  ValidationRule: 'type-validationrule',
  ApexClass: 'type-apexclass',
  ApexTrigger: 'type-apextrigger',
  CustomMetadata: 'type-custommetadata',
  User: 'type-user',
  CustomLabel: 'type-customlabel',
  NamedCredential: 'type-namedcredential',
  RemoteSiteSetting: 'type-remotesitesetting',
  ConnectedApp: 'type-connectedapp',
};

/**
 * Initializes the settings page: loads current settings and sets checkbox states.
 */
async function initSettingsPage(): Promise<void> {
  const settings = await loadSettings();

  // Set checkbox states based on loaded settings
  for (const metadataType of ALL_METADATA_TYPES) {
    const checkboxId = TYPE_TO_CHECKBOX_ID[metadataType];
    const checkbox = document.getElementById(checkboxId) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.checked = settings.enabledTypes.includes(metadataType);
    }
  }

  // Attach save button handler
  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', handleSave);
  }
}

/**
 * Reads the current checkbox states and saves settings.
 */
async function handleSave(): Promise<void> {
  const statusEl = document.getElementById('status-message');

  // Collect enabled types from checkboxes
  const enabledTypes: MetadataType[] = [];
  for (const metadataType of ALL_METADATA_TYPES) {
    const checkboxId = TYPE_TO_CHECKBOX_ID[metadataType];
    const checkbox = document.getElementById(checkboxId) as HTMLInputElement | null;
    if (checkbox?.checked) {
      enabledTypes.push(metadataType);
    }
  }

  // Build settings object
  const settings: UserSettings = {
    enabledTypes,
    maxResults: DEFAULT_SETTINGS.maxResults,
    version: DEFAULT_SETTINGS.version,
  };

  try {
    await saveSettings(settings);
    showStatus(statusEl, 'Settings saved successfully.', 'success');
  } catch {
    showStatus(statusEl, 'Failed to save settings. Please try again.', 'error');
  }
}

/**
 * Displays a status message to the user with appropriate styling.
 */
function showStatus(
  element: HTMLElement | null,
  message: string,
  type: 'success' | 'error'
): void {
  if (!element) return;

  element.textContent = message;
  element.className = `status-message ${type}`;

  // Auto-clear success messages after 3 seconds
  if (type === 'success') {
    setTimeout(() => {
      element.textContent = '';
      element.className = 'status-message';
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Initialize on DOM ready
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initSettingsPage);
