/**
 * SFDC Metadata Navigator - Fuse.js Search Integration
 *
 * Provides fuzzy search over the metadata index using Fuse.js.
 * Configured for fast, relevant results with a threshold appropriate
 * for partial/fuzzy matching on metadata item names.
 */

import Fuse from 'fuse.js';
import { IndexEntry } from '../shared/types';
import { MAX_RESULTS } from '../shared/constants';

/** Fuse.js configuration for fuzzy matching on metadata names */
const FUSE_OPTIONS: Fuse.IFuseOptions<IndexEntry> = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'objectName', weight: 1 },
  ],
  threshold: 0.5,
  includeScore: true,
  shouldSort: true,
  minMatchCharLength: 1,
  ignoreLocation: true,
};

/**
 * MetadataSearch encapsulates the Fuse.js search instance and provides
 * a simple interface for searching the metadata index.
 */
export class MetadataSearch {
  private fuse: Fuse<IndexEntry>;
  private entries: IndexEntry[];

  /**
   * Initialize with index data.
   * @param entries - The array of IndexEntry items to search over.
   */
  constructor(entries: IndexEntry[]) {
    this.entries = entries;
    this.fuse = new Fuse(entries, FUSE_OPTIONS);
  }

  /**
   * Search the index for entries matching the given query.
   *
   * @param query - The search string (supports fuzzy/partial matching)
   * @returns An array of matching IndexEntry items, capped at MAX_RESULTS (20)
   */
  search(query: string): IndexEntry[] {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const results = this.fuse.search(query, { limit: MAX_RESULTS });
    return results.map((result) => result.item);
  }

  /**
   * Update the search index with new data (e.g., after a refresh).
   * @param entries - The new array of IndexEntry items.
   */
  updateIndex(entries: IndexEntry[]): void {
    this.entries = entries;
    this.fuse = new Fuse(entries, FUSE_OPTIONS);
  }

  /**
   * Get the total number of entries in the current index.
   */
  getIndexSize(): number {
    return this.entries.length;
  }
}

/**
 * Convenience function: perform a one-off search against an array of index entries.
 * Initializes a Fuse.js instance and searches immediately.
 *
 * @param query - The search string
 * @param entries - The index entries to search over
 * @returns An array of matching IndexEntry items, capped at MAX_RESULTS (20)
 */
export function searchIndex(query: string, entries: IndexEntry[]): IndexEntry[] {
  const searcher = new MetadataSearch(entries);
  return searcher.search(query);
}
