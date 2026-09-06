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

// ---------------------------------------------------------------------------
// Permission Set Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the Id of the PermissionSet that Salesforce automatically creates
 * for a Profile (PermissionSet.ProfileId = profileId, IsOwnedByProfile = true).
 * This is NOT reachable via PermissionSetAssignment — it must be queried directly.
 */
export async function getProfilePermissionSetId(
  instanceUrl: string,
  sessionId: string,
  profileId: string
): Promise<string | null> {
  const escaped = escapeSoqlString(profileId);
  const soql = `SELECT Id FROM PermissionSet WHERE ProfileId = '${escaped}' LIMIT 1`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);
  return records.length > 0 ? (records[0] as any).Id : null;
}

export interface AssignedPermissionSet {
  permSetId: string;
  label: string;
  licenseId: string | null;
  licenseName: string | null;
}

/**
 * Returns the user's directly-assigned Permission Sets (excludes Permission Set
 * Group-derived assignments and the profile-owned Permission Set, which is
 * resolved separately via getProfilePermissionSetId). Permission Set Groups and
 * Muting Permission Sets are out of scope for v1 (see plan Global Constraints).
 */
export async function getAssignedPermissionSets(
  instanceUrl: string,
  sessionId: string,
  userId: string
): Promise<AssignedPermissionSet[]> {
  const escaped = escapeSoqlString(userId);
  const soql = `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.LicenseId, PermissionSet.License.Name FROM PermissionSetAssignment WHERE AssigneeId = '${escaped}' AND PermissionSetGroupId = null AND PermissionSet.IsOwnedByProfile = false`;
  const records = await queryRestApi(instanceUrl, sessionId, soql);

  return records.map((r: any) => ({
    permSetId: r.PermissionSetId,
    label: r.PermissionSet?.Label ?? '',
    licenseId: r.PermissionSet?.LicenseId ?? null,
    licenseName: r.PermissionSet?.License?.Name ?? null,
  }));
}
