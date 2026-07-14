/**
 * SFDC Metadata Navigator - Scanner UI Controller
 *
 * Search-driven class selection with max 5 classes.
 * User types to search -> selects classes -> clicks Scan -> sees results.
 */

import { OrgScanResult, ScanProgress } from './scanner';
import { ScanResult, RuleViolation } from './rules';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SELECTIONS = 5;
const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SelectedClass {
  id: string;
  name: string;
}

let selectedClasses: SelectedClass[] = [];
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentView: 'selection' | 'scanning' | 'results' = 'selection';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  // Events
  document.getElementById('class-search')!.addEventListener('input', handleSearchInput);
  document.getElementById('scan-btn')!.addEventListener('click', handleScan);
  document.getElementById('back-btn')!.addEventListener('click', () => switchView('selection'));

  // Listen for background messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SCAN_PROGRESS' && currentView === 'scanning') {
      updateProgress(message.progress);
    }
    if (message.type === 'SCAN_COMPLETE') {
      handleScanComplete(message.result);
    }
    if (message.type === 'SCAN_ERROR') {
      showError(message.error);
      switchView('selection');
    }
  });

  switchView('selection');
  (document.getElementById('class-search') as HTMLInputElement).focus();

  // Load suggested classes (recently modified)
  loadSuggestions();
}

// ---------------------------------------------------------------------------
// View Switching (using display style directly)
// ---------------------------------------------------------------------------

function switchView(view: 'selection' | 'scanning' | 'results'): void {
  currentView = view;

  const selectionPanel = document.getElementById('selection-panel')!;
  const scanningPanel = document.getElementById('scanning-panel')!;
  const resultsPanel = document.getElementById('results-panel')!;

  selectionPanel.style.display = view === 'selection' ? 'block' : 'none';
  scanningPanel.style.display = view === 'scanning' ? 'flex' : 'none';
  resultsPanel.style.display = view === 'results' ? 'block' : 'none';

  // Hide error when switching views
  document.getElementById('error-message')!.style.display = 'none';
}

function showError(message: string): void {
  const el = document.getElementById('error-message')!;
  document.getElementById('error-text')!.textContent = message;
  el.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Suggestions (Recently Modified Classes)
// ---------------------------------------------------------------------------

function loadSuggestions(): void {
  const container = document.getElementById('suggestions-section')!;
  container.innerHTML = '<p class="suggestions-loading">Loading recent classes...</p>';
  container.style.display = 'block';

  chrome.runtime.sendMessage({ action: 'getRecentClasses' }, (response) => {
    if (chrome.runtime.lastError || response?.error || !response?.classes?.length) {
      container.style.display = 'none';
      return;
    }

    renderSuggestions(response.classes);
  });
}

function renderSuggestions(classes: Array<{ Id: string; Name: string; LastModifiedDate: string; CreatedDate: string; isNew: boolean }>): void {
  const container = document.getElementById('suggestions-section')!;

  let html = '<div class="suggestions-header">Recently Modified</div><div class="suggestions-list">';

  for (const cls of classes) {
    const isSelected = selectedClasses.some(s => s.id === cls.Id);
    const isFull = selectedClasses.length >= MAX_SELECTIONS && !isSelected;
    const timeAgo = formatTimeAgo(cls.LastModifiedDate);
    const badge = cls.isNew ? '<span class="suggestion-badge new">NEW</span>' : '';

    html += `<div class="suggestion-item${isFull ? ' disabled' : ''}${isSelected ? ' selected' : ''}" data-id="${cls.Id}" data-name="${esc(cls.Name)}">
      <div class="suggestion-left">
        <span class="suggestion-name">${esc(cls.Name)}</span>
        <span class="suggestion-time">${timeAgo} ${badge}</span>
      </div>
      ${isSelected ? '<span class="suggestion-added">Added</span>' : '<span class="suggestion-add">+ Add</span>'}
    </div>`;
  }

  html += '</div>';
  container.innerHTML = html;
  container.style.display = 'block';

  // Attach click handlers
  container.querySelectorAll('.suggestion-item:not(.disabled):not(.selected)').forEach(item => {
    item.addEventListener('click', () => {
      const id = (item as HTMLElement).dataset.id!;
      const name = (item as HTMLElement).dataset.name!;
      addClass(id, name);
      // Re-render suggestions to update state
      chrome.runtime.sendMessage({ action: 'getRecentClasses' }, (response) => {
        if (response?.classes) renderSuggestions(response.classes);
      });
    });
  });
}

function formatTimeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function handleSearchInput(): void {
  const input = document.getElementById('class-search') as HTMLInputElement;
  const query = input.value.trim();
  const hint = document.getElementById('search-hint')!;
  const results = document.getElementById('search-results')!;
  const suggestions = document.getElementById('suggestions-section')!;

  // Hide error on new input
  document.getElementById('error-message')!.style.display = 'none';

  if (query.length < MIN_SEARCH_LENGTH) {
    results.style.display = 'none';
    suggestions.style.display = 'block';
    hint.textContent = 'Type at least 2 characters to search';
    return;
  }

  // Hide suggestions when searching
  suggestions.style.display = 'none';
  hint.textContent = 'Searching...';

  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => performSearch(query), SEARCH_DEBOUNCE_MS);
}

function performSearch(query: string): void {
  chrome.runtime.sendMessage({ action: 'searchClasses', query }, (response) => {
    const hint = document.getElementById('search-hint')!;

    if (chrome.runtime.lastError) {
      hint.textContent = 'Search failed. Make sure a Salesforce tab is open.';
      return;
    }
    if (response?.error) {
      hint.textContent = response.error;
      document.getElementById('search-results')!.style.display = 'none';
      return;
    }
    if (response?.classes) {
      renderSearchResults(response.classes);
    }
  });
}

function renderSearchResults(classes: Array<{ Id: string; Name: string; type: string }>): void {
  const container = document.getElementById('search-results')!;
  const hint = document.getElementById('search-hint')!;
  container.innerHTML = '';

  if (classes.length === 0) {
    container.innerHTML = '<div class="search-no-results">No classes found</div>';
    container.style.display = 'block';
    hint.textContent = '';
    return;
  }

  for (const cls of classes) {
    const isSelected = selectedClasses.some(s => s.id === cls.Id);
    const isFull = selectedClasses.length >= MAX_SELECTIONS && !isSelected;

    const item = document.createElement('div');
    item.className = `search-result-item${isFull ? ' disabled' : ''}`;

    if (isSelected) {
      item.innerHTML = `
        <span class="search-result-name">${esc(cls.Name)}</span>
        <span class="search-result-added">Added</span>
      `;
    } else {
      item.innerHTML = `
        <span class="search-result-name">${esc(cls.Name)}</span>
        <span class="search-result-type">${cls.type}</span>
      `;
      if (!isFull) {
        item.addEventListener('click', () => {
          addClass(cls.Id, cls.Name);
          renderSearchResults(classes);
        });
      }
    }

    container.appendChild(item);
  }

  container.style.display = 'block';
  hint.textContent = `${classes.length} result${classes.length !== 1 ? 's' : ''}`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function addClass(id: string, name: string): void {
  if (selectedClasses.length >= MAX_SELECTIONS) return;
  if (selectedClasses.some(s => s.id === id)) return;
  selectedClasses.push({ id, name });
  renderSelected();
}

function removeClass(id: string): void {
  selectedClasses = selectedClasses.filter(s => s.id !== id);
  renderSelected();
}

function renderSelected(): void {
  const section = document.getElementById('selected-section')!;
  const list = document.getElementById('selected-list')!;
  const count = document.getElementById('selected-count')!;
  const btn = document.getElementById('scan-btn') as HTMLButtonElement;

  if (selectedClasses.length === 0) {
    section.style.display = 'none';
    btn.disabled = true;
    return;
  }

  section.style.display = 'block';
  count.textContent = `(${selectedClasses.length}/${MAX_SELECTIONS})`;
  btn.disabled = false;

  list.innerHTML = '';
  for (const cls of selectedClasses) {
    const chip = document.createElement('div');
    chip.className = 'selected-chip';
    chip.innerHTML = `<span>${esc(cls.name)}</span><button class="selected-chip-remove" title="Remove">&times;</button>`;
    chip.querySelector('.selected-chip-remove')!.addEventListener('click', () => removeClass(cls.id));
    list.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function handleScan(): void {
  if (selectedClasses.length === 0) return;

  const classIds = selectedClasses.map(c => c.id);
  switchView('scanning');

  document.getElementById('progress-bar')!.style.width = '0%';
  document.getElementById('progress-text')!.textContent = '';
  document.getElementById('scanning-message')!.textContent =
    `Scanning ${classIds.length} class${classIds.length !== 1 ? 'es' : ''}...`;

  chrome.runtime.sendMessage({ action: 'scanSelected', classIds }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Failed to start scan.');
      switchView('selection');
      return;
    }
    if (response?.error) {
      showError(response.error);
      switchView('selection');
    }
  });
}

function updateProgress(progress: ScanProgress): void {
  if (progress.done) return;
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  document.getElementById('progress-bar')!.style.width = `${percent}%`;
  document.getElementById('progress-text')!.textContent = `${progress.completed} / ${progress.total}`;
  document.getElementById('scanning-message')!.textContent = `Scanning: ${progress.currentClass}`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function handleScanComplete(result: OrgScanResult): void {
  document.getElementById('total-classes')!.textContent = String(result.totalClasses);
  document.getElementById('classes-with-issues')!.textContent = String(result.classesWithIssues);
  document.getElementById('critical-count')!.textContent = String(result.summary.critical);
  document.getElementById('warning-count')!.textContent = String(result.summary.warning);
  document.getElementById('info-count')!.textContent = String(result.summary.info);

  const list = document.getElementById('violations-list')!;
  const noIssues = document.getElementById('no-issues-message')!;
  list.innerHTML = '';

  if (result.results.length === 0) {
    noIssues.style.display = 'block';
  } else {
    noIssues.style.display = 'none';
    for (const r of result.results) {
      list.appendChild(createClassGroup(r));
    }
  }

  switchView('results');
}

function createClassGroup(result: ScanResult): HTMLElement {
  const container = document.createElement('div');
  container.className = 'violation-class';

  const severity = result.violations.some(v => v.severity === 'critical') ? 'critical'
    : result.violations.some(v => v.severity === 'warning') ? 'warning' : 'info';

  const header = document.createElement('div');
  header.className = 'violation-class-header';
  header.innerHTML = `
    <span class="class-name">${esc(result.className)}</span>
    <span class="class-badge ${severity}">${result.violations.length} issue${result.violations.length !== 1 ? 's' : ''}</span>
  `;

  const items = document.createElement('div');
  items.className = 'violation-items';
  header.addEventListener('click', () => { items.hidden = !items.hidden; });

  for (const v of result.violations) {
    const item = document.createElement('div');
    item.className = 'violation-item';
    item.innerHTML = `
      <div class="violation-severity-badge ${v.severity}"></div>
      <div class="violation-content">
        <div class="violation-title">${esc(v.ruleName)}</div>
        <div class="violation-location">Line ${v.line}</div>
        <pre class="violation-snippet">${esc(v.snippet)}</pre>
        <div class="violation-fix">${esc(v.fix)}</div>
      </div>
    `;
    items.appendChild(item);
  }

  container.appendChild(header);
  container.appendChild(items);
  return container;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function esc(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);
