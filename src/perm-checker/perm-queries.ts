/**
 * SFDC Metadata Navigator - Perm Checker Query Module
 *
 * Wraps the existing queryRestApi() with the SOQL needed by the Perm Checker
 * feature. Kept separate from background.ts (which calls raw fetch inline for
 * most of its newer handlers) specifically so this logic is unit-testable by
 * mocking queryRestApi, the same way tests/background/index-builder.test.ts does.
 */

import { queryRestApi } from '../background/api';

function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Entity Search
// ---------------------------------------------------------------------------

export interface UserSearchResult {
  id: string;
  name: string;
  username: string;
  profileId: string;
  profileName: string;
}

export async function searchUsers(
  instanceUrl: string,
  sessionId: string,
  query: string
): Promise<UserSearchResult[]> {
  const escaped = escapeSoqlString(query);
  const soql = `SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE (Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%') AND IsActive = true ORDER BY Name LIMIT 20`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({
    id: r.Id,
    name: r.Name,
    username: r.Username,
    profileId: r.ProfileId,
    profileName: r.Profile?.Name ?? '',
  }));
}

export interface ProfileSearchResult {
  id: string;
  name: string;
}

export async function searchProfiles(
  instanceUrl: string,
  sessionId: string,
  query: string
): Promise<ProfileSearchResult[]> {
  const escaped = escapeSoqlString(query);
  const soql = `SELECT Id, Name FROM Profile WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 20`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({ id: r.Id, name: r.Name }));
}
