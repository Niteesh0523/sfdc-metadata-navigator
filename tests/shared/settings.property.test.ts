/**
 * Property Test: Settings Persistence Round Trip (Property 5)
 *
 * Property 5: Settings persistence round trip
 * For any valid user settings object, writing settings to storage and then
 * reading them back shall produce an equivalent settings object.
 *
 * Feature: sfdc-metadata-navigator-extension, Property 5: Settings persistence round trip
 * Validates: Requirements 7.3
 */

import * as fc from 'fast-check';
import { MetadataType, UserSettings } from '../../src/shared/types';
import { ALL_METADATA_TYPES, SETTINGS_KEY } from '../../src/shared/constants';

// Mock document.addEventListener before importing settings module
const originalDocument = global.document;
(global as any).document = {
  addEventListener: jest.fn(),
  getElementById: jest.fn(),
};

import { loadSettings, saveSettings } from '../../src/settings/settings';

// ---------------------------------------------------------------------------
// Mock Chrome Storage API
// ---------------------------------------------------------------------------

const mockSyncStorage: Record<string, unknown> = {};
const mockLocalStorage: Record<string, unknown> = {};

let syncSetShouldFail = false;
let syncGetShouldFail = false;

const chromeMock = {
  storage: {
    sync: {
      get: jest.fn(async (key: string) => {
        if (syncGetShouldFail) throw new Error('Sync storage unavailable');
        return { [key]: mockSyncStorage[key] ?? undefined };
      }),
      set: jest.fn(async (items: Record<string, unknown>) => {
        if (syncSetShouldFail) throw new Error('Sync storage write failed');
        Object.assign(mockSyncStorage, items);
      }),
    },
    local: {
      get: jest.fn(async (key: string) => {
        return { [key]: mockLocalStorage[key] ?? undefined };
      }),
      set: jest.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockLocalStorage, items);
      }),
    },
  },
};

(global as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

describe('Property 5: Settings persistence round trip', () => {
  const metadataTypes: MetadataType[] = ALL_METADATA_TYPES;

  // Arbitrary for generating valid UserSettings
  const userSettingsArb = fc.record({
    enabledTypes: fc.subarray(metadataTypes, { minLength: 0, maxLength: metadataTypes.length }),
    maxResults: fc.integer({ min: 1, max: 100 }),
    version: fc.integer({ min: 1, max: 10 }),
  }) as fc.Arbitrary<UserSettings>;

  beforeEach(() => {
    // Clear mock storages
    for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
    syncSetShouldFail = false;
    syncGetShouldFail = false;
    jest.clearAllMocks();
  });

  it('should produce equivalent settings after save then load (sync storage)', async () => {
    await fc.assert(
      fc.asyncProperty(userSettingsArb, async (settings) => {
        // Clear storage
        for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];

        await saveSettings(settings);
        const loaded = await loadSettings();

        expect(loaded.enabledTypes).toEqual(settings.enabledTypes);
        expect(loaded.maxResults).toBe(settings.maxResults);
        expect(loaded.version).toBe(settings.version);
      }),
      { numRuns: 100 }
    );
  });

  it('should produce equivalent settings after save then load (local storage fallback)', async () => {
    await fc.assert(
      fc.asyncProperty(userSettingsArb, async (settings) => {
        // Clear storage
        for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];
        for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];

        // Force sync storage to fail on write — should fall back to local
        syncSetShouldFail = true;

        await saveSettings(settings);

        // Verify it was stored in local storage
        expect(mockLocalStorage[SETTINGS_KEY]).toEqual(settings);

        // Now load — sync get will return nothing, so it falls back to local
        syncGetShouldFail = false;
        const loaded = await loadSettings();

        expect(loaded.enabledTypes).toEqual(settings.enabledTypes);
        expect(loaded.maxResults).toBe(settings.maxResults);
        expect(loaded.version).toBe(settings.version);

        syncSetShouldFail = false;
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve enabledTypes order through round trip', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(metadataTypes, { minLength: 1, maxLength: metadataTypes.length }),
        async (shuffledTypes) => {
          for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];

          const settings: UserSettings = {
            enabledTypes: shuffledTypes,
            maxResults: 20,
            version: 1,
          };

          await saveSettings(settings);
          const loaded = await loadSettings();

          // Order should be preserved
          expect(loaded.enabledTypes).toEqual(shuffledTypes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should handle empty enabledTypes array', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 5 }),
        async (maxResults, version) => {
          for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];

          const settings: UserSettings = {
            enabledTypes: [],
            maxResults,
            version,
          };

          await saveSettings(settings);
          const loaded = await loadSettings();

          expect(loaded.enabledTypes).toEqual([]);
          expect(loaded.maxResults).toBe(maxResults);
          expect(loaded.version).toBe(version);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('should not mutate the original settings object during save', async () => {
    await fc.assert(
      fc.asyncProperty(userSettingsArb, async (settings) => {
        for (const key of Object.keys(mockSyncStorage)) delete mockSyncStorage[key];

        // Deep clone to compare after
        const original = JSON.parse(JSON.stringify(settings));

        await saveSettings(settings);

        // Original object should be unchanged
        expect(settings).toEqual(original);
      }),
      { numRuns: 100 }
    );
  });
});
