/**
 * SFDC Metadata Navigator - Keyboard Navigation & Result Interaction
 *
 * Handles keyboard navigation (Up/Down/Enter) through search results
 * and mouse click interactions (regular click for same tab, Ctrl/Cmd+Click for new tab).
 */

import { IndexEntry } from '../shared/types';

/**
 * Callback type for when a result is selected by the user.
 * @param entry - The selected IndexEntry
 * @param openInNewTab - Whether to open in a new tab (Ctrl/Cmd+Click)
 */
export type ResultSelectionCallback = (entry: IndexEntry, openInNewTab: boolean) => void;

/**
 * NavigationController manages keyboard and mouse interactions
 * on the search results list.
 */
export class NavigationController {
  private resultsList: HTMLUListElement;
  private highlightedIndex: number = -1;
  private currentEntries: IndexEntry[] = [];
  private onSelect: ResultSelectionCallback;

  /**
   * @param resultsList - The UL element containing result items
   * @param onSelect - Callback invoked when a result is selected
   */
  constructor(resultsList: HTMLUListElement, onSelect: ResultSelectionCallback) {
    this.resultsList = resultsList;
    this.onSelect = onSelect;
  }

  /**
   * Attaches keyboard event listener to the given input element.
   * Should be called once during initialization.
   */
  attachKeyboardListener(searchInput: HTMLInputElement): void {
    searchInput.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  /**
   * Updates the list of current entries when search results change.
   * Resets the highlighted index.
   */
  updateEntries(entries: IndexEntry[]): void {
    this.currentEntries = entries;
    this.highlightedIndex = -1;
  }

  /**
   * Renders the search results into the results list element.
   * Attaches click listeners for mouse interaction.
   */
  renderResults(entries: IndexEntry[]): void {
    this.updateEntries(entries);
    this.resultsList.innerHTML = '';

    entries.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.index = String(index);

      li.innerHTML = `
        <div class="result-item-left">
          <span class="result-item-name">${escapeHtml(entry.name)}</span>
          ${entry.objectName ? `<span class="result-item-object">${escapeHtml(entry.objectName)}</span>` : ''}
        </div>
        <span class="result-item-type">${escapeHtml(entry.typeLabel)}</span>
      `;

      // Mouse click handler
      li.addEventListener('click', (event: MouseEvent) => {
        const openInNewTab = event.ctrlKey || event.metaKey;
        this.onSelect(entry, openInNewTab);
      });

      // Hover highlights the item
      li.addEventListener('mouseenter', () => {
        this.setHighlightedIndex(index);
      });

      this.resultsList.appendChild(li);
    });
  }

  /**
   * Clears the results list and resets state.
   */
  clearResults(): void {
    this.resultsList.innerHTML = '';
    this.currentEntries = [];
    this.highlightedIndex = -1;
  }

  /**
   * Returns the currently highlighted index (-1 if none).
   */
  getHighlightedIndex(): number {
    return this.highlightedIndex;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Handles keydown events on the search input for arrow navigation and Enter.
   */
  private handleKeyDown(event: KeyboardEvent): void {
    const itemCount = this.currentEntries.length;
    if (itemCount === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveHighlight(1);
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.moveHighlight(-1);
        break;

      case 'Enter':
        event.preventDefault();
        if (this.highlightedIndex >= 0 && this.highlightedIndex < itemCount) {
          const entry = this.currentEntries[this.highlightedIndex];
          const openInNewTab = event.ctrlKey || event.metaKey;
          this.onSelect(entry, openInNewTab);
        }
        break;
    }
  }

  /**
   * Moves the highlighted index by the given delta, wrapping around edges.
   */
  private moveHighlight(delta: number): void {
    const itemCount = this.currentEntries.length;
    if (itemCount === 0) return;

    let newIndex: number;
    if (this.highlightedIndex === -1) {
      // No current highlight — start from top (for Down) or bottom (for Up)
      newIndex = delta > 0 ? 0 : itemCount - 1;
    } else {
      newIndex = (this.highlightedIndex + delta + itemCount) % itemCount;
    }

    this.setHighlightedIndex(newIndex);
  }

  /**
   * Sets the highlighted index and updates DOM classes for visual feedback.
   */
  private setHighlightedIndex(index: number): void {
    // Remove highlight from previous item
    if (this.highlightedIndex >= 0) {
      const prevItem = this.resultsList.children[this.highlightedIndex] as HTMLElement | undefined;
      if (prevItem) {
        prevItem.classList.remove('highlighted');
        prevItem.setAttribute('aria-selected', 'false');
      }
    }

    this.highlightedIndex = index;

    // Add highlight to new item
    if (index >= 0 && index < this.resultsList.children.length) {
      const newItem = this.resultsList.children[index] as HTMLElement;
      newItem.classList.add('highlighted');
      newItem.setAttribute('aria-selected', 'true');

      // Scroll the highlighted item into view
      newItem.scrollIntoView({ block: 'nearest' });
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent XSS when rendering entry names.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
