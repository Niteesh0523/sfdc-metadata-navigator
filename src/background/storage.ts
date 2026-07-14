/**
 * SFDC Metadata Navigator - Storage Manager
 *
 * Manages per-org search index persistence in Chrome local storage.
 * Each org's index is stored under a unique key: `index_{orgId}`.
 */

import { OrgIndex } from '../shared/types';
import { STORAGE_KEY_PREFIX } from '../shared/constants';

/**
 * Constructs the Chrome local storage key for a given org ID.
 * @param orgId - 15-char Salesforce org identifier
 * @returns Storage key in the format `index_{orgId}`
 */
export function getStorageKey(orgId: string): string {
  return STORAGE_KEY_PREFIX + orgId;
}

/**
 * Saves an OrgIndex to Chrome local storage.
 * @param orgIndex - The org index to persist
 */
export async function saveOrgIndex(orgIndex: OrgIndex): Promise<void> {
  const key = getStorageKey(orgIndex.orgId);
  await chrome.storage.local.set({ [key]: orgIndex });
}

/**
 * Loads an OrgIndex from Chrome local storage.
 * @param orgId - The org ID whose index to retrieve
 * @returns The stored OrgIndex, or null if not found
 */
export async function loadOrgIndex(orgId: string): Promise<OrgIndex | null> {
  const key = getStorageKey(orgId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as OrgIndex) ?? null;
}

/**
 * Removes an org's index from Chrome local storage.
 * @param orgId - The org ID whose index to delete
 */
export async function deleteOrgIndex(orgId: string): Promise<void> {
  const key = getStorageKey(orgId);
  await chrome.storage.local.remove(key);
}
