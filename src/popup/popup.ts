/**
 * SFDC Metadata Navigator - Popup Main Controller
 *
 * Orchestrates the popup lifecycle:
 * 1. Checks if the active tab is on a Salesforce domain
 * 2. Requests org info from the content script via background
 * 3. Loads the per-org search index from Chrome local storage
 * 4. Initializes Fuse.js search and keyboard navigation
 * 5. Handles refresh, navigation, and state transitions
 *
 * State Machine:
 *   CheckingOrg → NotSalesforce | LoadingIndex
 *   LoadingIndex → NoIndex | Ready
 *   Ready ↔ Searching
 *   Ready → Refreshing → Ready | Error
 *   Error → Ready (dismiss)
 */

import { IndexEntry, OrgIndex } from '../shared/types';
import { STORAGE_KEY_PREFIX, STALE_THRESHOLD } from '../shared/constants';
import { isSalesforceDomain } from '../shared/domain-utils';
import { MetadataSearch } from './search';
import { NavigationController } from './navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PopupState =
  | 'checking-org'
  | 'not-salesforce'
  | 'loading-index'
  | 'no-index'
  | 'ready'
  | 'searching'
  | 'refreshing'
  | 'error';

// ---------------------------------------------------------------------------
// DOM Elements
// ---------------------------------------------------------------------------

let popupContainer: HTMLElement;
let searchInput: HTMLInputElement;
let resultsList: HTMLUListElement;
let noResultsMessage: HTMLElement;
let lastRefreshedEl: HTMLElement;
let staleIndicator: HTMLElement;
let refreshBtn: HTMLElement;
let noIndexRefreshBtn: HTMLElement;
let refreshProgress: HTMLElement;
let errorMessageEl: HTMLElement;
let errorDismissBtn: HTMLElement;
let settingsLink: HTMLElement;
let scannerLink: HTMLElement;
let permCheckerLink: HTMLElement;
let orginfoLink: HTMLElement;
let fieldInspectorLink: HTMLElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentState: PopupState = 'checking-org';
let currentOrgId: string | null = null;
let currentInstanceUrl: string | null = null;
let metadataSearch: MetadataSearch | null = null;
let navigationController: NavigationController;

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

/**
 * Transitions the popup to a new state, updating the DOM accordingly.
 */
function setState(newState: PopupState): void {
  currentState = newState;
  popupContainer.setAttribute('data-state', newState);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Main initialization function. Called on DOMContentLoaded.
 */
async function init(): Promise<void> {
  // Cache DOM references
  popupContainer = document.getElementById('popup-container')!;
  searchInput = document.getElementById('search-input') as HTMLInputElement;
  resultsList = document.getElementById('results-list') as HTMLUListElement;
  noResultsMessage = document.getElementById('no-results-message')!;
  lastRefreshedEl = document.getElementById('last-refreshed')!;
  staleIndicator = document.getElementById('stale-indicator')!;
  refreshBtn = document.getElementById('refresh-btn')!;
  noIndexRefreshBtn = document.getElementById('no-index-refresh-btn')!;
  refreshProgress = document.getElementById('refresh-progress')!;
  errorMessageEl = document.getElementById('error-message')!;
  errorDismissBtn = document.getElementById('error-dismiss-btn')!;
  settingsLink = document.getElementById('settings-link')!;
  scannerLink = document.getElementById('scanner-link')!;
  permCheckerLink = document.getElementById('perm-checker-link')!;
  orginfoLink = document.getElementById('orginfo-link')!;
  fieldInspectorLink = document.getElementById('field-inspector-link')!;

  // Initialize navigation controller
  navigationController = new NavigationController(resultsList, handleResultSelection);
  navigationController.attachKeyboardListener(searchInput);

  // Attach event listeners
  searchInput.addEventListener('input', handleSearchInput);
  refreshBtn.addEventListener('click', handleRefresh);
  noIndexRefreshBtn.addEventListener('click', handleRefresh);
  errorDismissBtn.addEventListener('click', handleErrorDismiss);
  settingsLink.addEventListener('click', handleSettingsClick);
  scannerLink.addEventListener('click', handleScannerClick);
  permCheckerLink.addEventListener('click', handlePermCheckerClick);
  orginfoLink.addEventListener('click', handleOrginfoClick);
  fieldInspectorLink.addEventListener('click', handleFieldInspectorClick);

  // Start the state machine
  setState('checking-org');
  await checkActiveTab();
}

// ---------------------------------------------------------------------------
// Active Tab & Org Detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the active tab is on a Salesforce domain.
 * If yes, queries the content script for org info.
 */
async function checkActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url || !isSalesforceDomain(tab.url)) {
      setState('not-salesforce');
      return;
    }

    // Tab is on Salesforce — get org info from content script
    await requestOrgInfo(tab.id!);
  } catch {
    setState('not-salesforce');
  }
}

/**
 * Sends a message to the content script on the given tab to extract org info.
 * If the content script isn't injected yet, injects it programmatically first.
 */
async function requestOrgInfo(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getOrgInfo' });

    if (response && 'orgId' in response && response.orgId) {
      currentOrgId = response.orgId;
      currentInstanceUrl = response.instanceUrl;
      await loadIndex();
    } else {
      // Content script responded but couldn't extract org info
      await fallbackToTabUrl(tabId);
    }
  } catch {
    // Content script not available — try programmatic injection
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['js/content/content.js'],
      });

      // Wait a moment for the script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Retry the message
      const response = await chrome.tabs.sendMessage(tabId, { action: 'getOrgInfo' });
      if (response && 'orgId' in response && response.orgId) {
        currentOrgId = response.orgId;
        currentInstanceUrl = response.instanceUrl;
        await loadIndex();
      } else {
        await fallbackToTabUrl(tabId);
      }
    } catch {
      // Injection also failed — fallback
      await fallbackToTabUrl(tabId);
    }
  }
}

/**
 * Fallback when content script is unavailable: extract instance URL from the tab URL
 * and try getting org ID via background worker's cookie API.
 */
async function fallbackToTabUrl(tabId: number): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      currentInstanceUrl = url.origin;

      // Try getting org ID from background worker (reads HttpOnly oid cookie)
      const response = await chrome.runtime.sendMessage({
        action: 'getOrgId',
        domain: currentInstanceUrl,
      });
      if (response?.orgId) {
        currentOrgId = response.orgId;
        await loadIndex();
        return;
      }
    }
  } catch { /* ignore */ }
  setState('no-index');
}

// ---------------------------------------------------------------------------
// Index Loading
// ---------------------------------------------------------------------------

/**
 * Loads the search index for the current org from Chrome local storage.
 */
async function loadIndex(): Promise<void> {
  if (!currentOrgId) {
    setState('no-index');
    return;
  }

  setState('loading-index');

  try {
    const key = STORAGE_KEY_PREFIX + currentOrgId;
    const result = await chrome.storage.local.get(key);
    const orgIndex = result[key] as OrgIndex | undefined;

    if (!orgIndex || !orgIndex.entries || orgIndex.entries.length === 0) {
      setState('no-index');
      return;
    }

    // Detect org switch: if stored instance URL differs from current
    if (currentInstanceUrl && orgIndex.instanceUrl !== currentInstanceUrl) {
      // Org URLs don't match — might be a different org using same org ID (unlikely)
      // or the instance URL changed. Use the index but suggest refresh.
    }

    // Initialize search
    metadataSearch = new MetadataSearch(orgIndex.entries);

    // Update refresh timestamp display
    updateRefreshTimestamp(orgIndex.lastRefreshed);

    setState('ready');

    // Focus the search input
    searchInput.focus();

    // Load recently viewed records
    loadRecentlyViewed();
  } catch {
    setState('no-index');
  }
}

// ---------------------------------------------------------------------------
// Recently Viewed Records
// ---------------------------------------------------------------------------

/**
 * Fetches and displays recently viewed records from Salesforce.
 */
async function loadRecentlyViewed(): Promise<void> {
  const listEl = document.getElementById('recently-viewed-list')!;
  const emptyEl = document.getElementById('recently-viewed-empty')!;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'getRecentlyViewed' });

    if (response?.error || !response?.records || response.records.length === 0) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    listEl.innerHTML = '';

    for (const record of response.records) {
      const li = document.createElement('li');
      li.className = 'recent-item';

      const timeAgo = formatRelativeTime(Date.now() - new Date(record.LastViewedDate).getTime());

      li.innerHTML = `
        <div class="recent-item-left">
          <span class="recent-item-name">${escapeHtmlPopup(record.Name || 'Untitled')}</span>
          <span class="recent-item-time">${timeAgo}</span>
        </div>
        <span class="recent-item-type">${escapeHtmlPopup(record.Type || '')}</span>
      `;

      li.addEventListener('click', () => {
        if (currentInstanceUrl && record.Id) {
          chrome.tabs.create({ url: `${currentInstanceUrl}/${record.Id}` });
          window.close();
        }
      });

      listEl.appendChild(li);
    }
  } catch {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
  }
}

function escapeHtmlPopup(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Search Handling
// ---------------------------------------------------------------------------

/**
 * Handles input events on the search field — triggers fuzzy search.
 */
function handleSearchInput(): void {
  const query = searchInput.value.trim();

  if (!metadataSearch) return;

  const recentlyViewed = document.getElementById('recently-viewed')!;

  if (query.length === 0) {
    // Show recently viewed when search is empty
    navigationController.clearResults();
    noResultsMessage.hidden = true;
    recentlyViewed.style.display = 'block';
    setState('ready');
    return;
  }

  // Hide recently viewed when searching
  recentlyViewed.style.display = 'none';

  setState('searching');

  const results = metadataSearch.search(query);

  if (results.length === 0) {
    navigationController.clearResults();
    noResultsMessage.hidden = false;
  } else {
    noResultsMessage.hidden = true;
    navigationController.renderResults(results);
  }
}

// ---------------------------------------------------------------------------
// Result Selection (Navigation)
// ---------------------------------------------------------------------------

/**
 * Called when the user selects a result (Enter, click, or Ctrl/Cmd+click).
 * Opens the metadata Setup URL in the active tab or a new tab.
 */
function handleResultSelection(entry: IndexEntry, openInNewTab: boolean): void {
  if (!currentInstanceUrl) return;

  // Build the full URL from instance URL + relative path
  const fullUrl = currentInstanceUrl + entry.url;

  // Always open in a new tab
  chrome.tabs.create({ url: fullUrl });

  // Close the popup
  window.close();
}

// ---------------------------------------------------------------------------
// Refresh Handling
// ---------------------------------------------------------------------------

/**
 * Handles refresh button click — triggers index rebuild via background service worker.
 */
async function handleRefresh(): Promise<void> {
  if (!currentOrgId || !currentInstanceUrl) {
    // Try to get org info via content script (with programmatic injection fallback)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        // Try sending message to content script
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getOrgInfo' });
          if (response && 'orgId' in response && response.orgId) {
            currentOrgId = response.orgId;
            currentInstanceUrl = response.instanceUrl;
          }
        } catch {
          // Content script not available — inject it
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['js/content/content.js'],
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getOrgInfo' });
            if (response && 'orgId' in response && response.orgId) {
              currentOrgId = response.orgId;
              currentInstanceUrl = response.instanceUrl;
            }
          } catch { /* ignore */ }
        }

        // If we still don't have orgId, try background worker cookie-based extraction
        if (!currentOrgId && tab.url) {
          currentInstanceUrl = new URL(tab.url).origin;
          try {
            const bgResponse = await chrome.runtime.sendMessage({
              action: 'getOrgId',
              domain: currentInstanceUrl,
            });
            if (bgResponse?.orgId) {
              currentOrgId = bgResponse.orgId;
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // If we still don't have org info, show error
    if (!currentOrgId || !currentInstanceUrl) {
      showError('Unable to identify the Salesforce org. Please reload the page and try again.');
      return;
    }
  }

  setState('refreshing');
  refreshProgress.hidden = false;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'refreshIndex',
      orgId: currentOrgId,
      instanceUrl: currentInstanceUrl,
    });

    refreshProgress.hidden = true;

    if (response?.success) {
      // Reload the index
      await loadIndex();
    } else {
      showError(response?.error || 'An unexpected error occurred during refresh.');
    }
  } catch (error: unknown) {
    refreshProgress.hidden = true;
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    showError(message);
  }
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

/**
 * Transitions to error state with a user-facing message.
 */
function showError(message: string): void {
  errorMessageEl.textContent = message;
  setState('error');
}

/**
 * Handles dismiss button in error state — returns to ready or no-index.
 */
function handleErrorDismiss(): void {
  if (metadataSearch && metadataSearch.getIndexSize() > 0) {
    setState('ready');
  } else {
    setState('no-index');
  }
}

// ---------------------------------------------------------------------------
// Refresh Timestamp
// ---------------------------------------------------------------------------

/**
 * Updates the "Last refreshed" display and stale indicator.
 */
function updateRefreshTimestamp(timestamp: number): void {
  const now = Date.now();
  const elapsed = now - timestamp;

  lastRefreshedEl.textContent = `Last refreshed: ${formatRelativeTime(elapsed)}`;

  // Show stale indicator if older than 24 hours
  if (elapsed > STALE_THRESHOLD) {
    staleIndicator.hidden = false;
  } else {
    staleIndicator.hidden = true;
  }
}

/**
 * Formats a millisecond duration into a human-readable relative time string.
 */
function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Opens the settings page in a new tab.
 */
function handleSettingsClick(event: Event): void {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
}

/**
 * Opens the Org Health Scanner page in a new tab.
 */
function handleScannerClick(event: Event): void {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('scanner/scanner.html') });
}

/**
 * Opens the Org Info Dashboard page in a new tab.
 */
function handleOrginfoClick(event: Event): void {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('orginfo/orginfo.html') });
}

/**
 * Opens the Perm Checker page in a new tab.
 */
function handlePermCheckerClick(event: Event): void {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('perm-checker/perm-checker.html') });
}

/**
 * Activates the Field Inspector on the active Salesforce tab.
 */
async function handleFieldInspectorClick(event: Event): Promise<void> {
  event.preventDefault();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // Inject the field inspector script into the active tab
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['js/field-inspector/field-inspector.js'],
    });

    // Activate it
    await chrome.tabs.sendMessage(tab.id, { action: 'activateFieldInspector' });

    // Close popup
    window.close();
  } catch {
    // If injection fails, the tab might not be a Salesforce page
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);
