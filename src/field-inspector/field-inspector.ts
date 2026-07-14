/**
 * SFDC Metadata Navigator - Field API Inspector
 *
 * Injected into Salesforce record pages when activated.
 * Adds hover tooltips on fields showing:
 * - Field API Name
 * - Field Type & Length
 * - Current Value
 * - Link to Field-Level Security
 * - Where the field is used (Layouts, Validation Rules, etc.)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isActive = false;
let currentTooltip: HTMLElement | null = null;
let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
let fieldCache: Map<string, FieldInfo> = new Map();
let preloadPromise: Promise<void> | null = null;

interface FieldInfo {
  apiName: string;
  label: string;
  type: string;
  length?: number;
  required: boolean;
  custom: boolean;
  objectName: string;
  fieldId?: string;
  helpText?: string;
  usedIn?: { layouts: number; validationRules: number; flows: number };
}

// ---------------------------------------------------------------------------
// Activation / Deactivation
// ---------------------------------------------------------------------------

/**
 * Activates the field inspector overlay on the current page.
 */
export function activate(): void {
  if (isActive) return;
  isActive = true;

  // Add overlay indicator
  addIndicator();

  // Preload all fields for the current object (hover waits on this promise)
  preloadPromise = preloadFields();

  // Add hover listeners to field elements
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);

  // Add escape key to deactivate
  document.addEventListener('keydown', handleKeyDown);
}

/**
 * Preloads all field metadata for the current object into the cache.
 */
async function preloadFields(): Promise<void> {
  const objectName = getObjectNameFromUrl();
  if (!objectName) return;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getAllFieldsForObject',
      objectName,
    });

    if (response?.fields) {
      for (const field of response.fields) {
        // Cache by both label and API name for fast lookup
        fieldCache.set(`${objectName}.${field.label}`, field);
        fieldCache.set(`${objectName}.${field.apiName}`, field);
      }
    }
  } catch { /* preload failed — will query on demand */ }
}

/**
 * Deactivates the field inspector.
 */
export function deactivate(): void {
  if (!isActive) return;
  isActive = false;

  removeIndicator();
  removeTooltip();

  document.removeEventListener('mouseover', handleMouseOver, true);
  document.removeEventListener('mouseout', handleMouseOut, true);
  document.removeEventListener('keydown', handleKeyDown);
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    deactivate();
  }
}

// ---------------------------------------------------------------------------
// Indicator (shows that inspector mode is active)
// ---------------------------------------------------------------------------

function addIndicator(): void {
  if (document.getElementById('sfdc-field-inspector-indicator')) return;

  const indicator = document.createElement('div');
  indicator.id = 'sfdc-field-inspector-indicator';
  indicator.innerHTML = `
    <span>🔍 Field Inspector Active</span>
    <button id="sfdc-field-inspector-close">✕</button>
  `;
  indicator.style.cssText = `
    position: fixed;
    top: 8px;
    right: 8px;
    z-index: 999999;
    background: #1b96ff;
    color: white;
    padding: 8px 14px;
    border-radius: 20px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  `;

  document.body.appendChild(indicator);

  document.getElementById('sfdc-field-inspector-close')!.addEventListener('click', deactivate);
  document.getElementById('sfdc-field-inspector-close')!.style.cssText = `
    background: rgba(255,255,255,0.2);
    border: none;
    color: white;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 50%;
  `;
}

function removeIndicator(): void {
  document.getElementById('sfdc-field-inspector-indicator')?.remove();
}

// ---------------------------------------------------------------------------
// Hover Handling
// ---------------------------------------------------------------------------

function handleMouseOver(e: MouseEvent): void {
  if (!isActive) return;

  const target = e.target as HTMLElement;
  const fieldElement = findFieldElement(target);

  if (!fieldElement) return;

  // Highlight the field
  fieldElement.style.outline = '2px solid #1b96ff';
  fieldElement.style.outlineOffset = '2px';
  fieldElement.style.borderRadius = '4px';

  // Show tooltip after a short delay
  if (hoverTimeout) clearTimeout(hoverTimeout);
  hoverTimeout = setTimeout(() => {
    showFieldTooltip(fieldElement);
  }, 300);
}

function handleMouseOut(e: MouseEvent): void {
  if (!isActive) return;

  const target = e.target as HTMLElement;
  const fieldElement = findFieldElement(target);

  if (fieldElement) {
    fieldElement.style.outline = '';
    fieldElement.style.outlineOffset = '';
    fieldElement.style.borderRadius = '';
  }

  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }

  // Remove tooltip if mouse leaves the field area
  setTimeout(() => {
    if (currentTooltip && !currentTooltip.matches(':hover')) {
      removeTooltip();
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// Field Element Detection
// ---------------------------------------------------------------------------

/**
 * Finds the Lightning field wrapper element from any child element.
 * Lightning record pages use these components for fields:
 * - lightning-output-field
 * - records-record-layout-item
 * - force-record-layout-item
 * - lightning-input-field
 */
function findFieldElement(target: HTMLElement): HTMLElement | null {
  const selectors = [
    'lightning-output-field',
    'records-record-layout-item',
    'force-record-layout-item',
    'lightning-input-field',
    '[data-field-id]',
    '.slds-form-element',
  ];

  for (const selector of selectors) {
    const found = target.closest(selector) as HTMLElement | null;
    if (found) return found;
  }

  return null;
}

/**
 * Extracts the field label from a field element.
 */
function getFieldLabel(fieldElement: HTMLElement): string {
  // Try various label selectors used in Lightning
  const labelSelectors = [
    '.slds-form-element__label',
    'label',
    'span[class*="label"]',
    '.test-id__field-label',
    '[class*="outputLookup"] span',
  ];

  for (const selector of labelSelectors) {
    const labelEl = fieldElement.querySelector(selector);
    if (labelEl?.textContent?.trim()) {
      return labelEl.textContent.trim();
    }
  }

  // Fallback: check data attributes
  const fieldName = fieldElement.getAttribute('data-field-id') ||
    fieldElement.getAttribute('data-field-api-name') ||
    fieldElement.getAttribute('field-name');
  if (fieldName) return fieldName;

  return '';
}

/**
 * Extracts the current field value from the element.
 */
function getFieldValue(fieldElement: HTMLElement): string {
  const valueSelectors = [
    '.slds-form-element__static',
    'lightning-formatted-text',
    'lightning-formatted-number',
    'lightning-formatted-date-time',
    'lightning-formatted-email',
    'lightning-formatted-phone',
    'lightning-formatted-url',
    'lightning-formatted-name',
    'lightning-formatted-rich-text',
    'a[data-refid]',
    '.slds-truncate',
  ];

  for (const selector of valueSelectors) {
    const valueEl = fieldElement.querySelector(selector);
    if (valueEl?.textContent?.trim()) {
      return valueEl.textContent.trim();
    }
  }

  return '—';
}

// ---------------------------------------------------------------------------
// Tooltip Display
// ---------------------------------------------------------------------------

async function showFieldTooltip(fieldElement: HTMLElement): Promise<void> {
  removeTooltip();

  const label = getFieldLabel(fieldElement);
  const value = getFieldValue(fieldElement);

  if (!label) return;

  const objectName = getObjectNameFromUrl();

  // Check cache first (instant)
  const cacheKey = `${objectName}.${label}`;
  const cached = fieldCache.get(cacheKey);

  const tooltip = createTooltipElement(fieldElement);
  document.body.appendChild(tooltip);
  currentTooltip = tooltip;

  if (cached) {
    // Instant render from cache
    tooltip.innerHTML = getFieldInfoHtml(cached, value, objectName);
    attachTooltipLinks(tooltip);
    return;
  }

  // Not in cache yet — the preload may still be running. Wait for it.
  tooltip.innerHTML = getLoadingHtml(label, value);

  if (preloadPromise) {
    await preloadPromise;
    // Re-check cache after preload completes
    const afterPreload = fieldCache.get(cacheKey);
    if (afterPreload && currentTooltip === tooltip) {
      tooltip.innerHTML = getFieldInfoHtml(afterPreload, value, objectName);
      attachTooltipLinks(tooltip);
      return;
    }
  }

  // Still not found (label mismatch, compound field, etc.) — show what we know
  if (currentTooltip === tooltip) {
    tooltip.innerHTML = getErrorHtml(label, value);
  }
}

function attachTooltipLinks(tooltip: HTMLElement): void {
  tooltip.querySelectorAll('a[data-url]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = (link as HTMLElement).dataset.url!;
      chrome.runtime.sendMessage({ action: 'openUrl', url });
    });
  });

  // FLS link toggles an inline permissions panel
  const flsLink = tooltip.querySelector('a[data-action="show-fls"]') as HTMLElement | null;
  if (flsLink) {
    flsLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const panel = tooltip.querySelector('.sfdc-fls-panel') as HTMLElement;
      if (!panel) return;

      if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
      }

      panel.style.display = 'block';

      if (!panel.dataset.loaded) {
        panel.innerHTML = '<div style="padding:10px 14px; color:#888; font-size:11px;">Loading permissions...</div>';
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'getFieldPermissions',
            objectName: flsLink.dataset.object,
            fieldApiName: flsLink.dataset.field,
          });

          if (response?.permissions?.length) {
            panel.dataset.loaded = '1';
            panel.innerHTML = renderFlsPanel(response.permissions);
          } else {
            panel.innerHTML = '<div style="padding:10px 14px; color:#999; font-size:11px;">No profile or permission set grants access to this field (or it is not permissionable).</div>';
          }
        } catch {
          panel.innerHTML = '<div style="padding:10px 14px; color:#c0392b; font-size:11px;">Failed to load permissions.</div>';
        }
      }
    });
  }
}

function renderFlsPanel(permissions: Array<{ name: string; isProfile: boolean; read: boolean; edit: boolean }>): string {
  let html = `
    <div style="display:grid; grid-template-columns: 1fr 40px 40px; gap:4px; padding:8px 14px 4px; font-size:9px; font-weight:600; text-transform:uppercase; color:#999;">
      <span>Profile / Permission Set</span><span style="text-align:center;">Read</span><span style="text-align:center;">Edit</span>
    </div>
  `;

  for (const p of permissions) {
    const badge = p.isProfile
      ? '<span style="background:#e3f2fd;color:#1565c0;padding:0 4px;border-radius:2px;font-size:9px;margin-left:4px;">Profile</span>'
      : '<span style="background:#f3e5f5;color:#7b1fa2;padding:0 4px;border-radius:2px;font-size:9px;margin-left:4px;">PermSet</span>';
    html += `
      <div style="display:grid; grid-template-columns: 1fr 40px 40px; gap:4px; padding:4px 14px; font-size:11px; color:#333; border-top:1px solid #f5f5f5; align-items:center;">
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(p.name)}${badge}</span>
        <span style="text-align:center;">${p.read ? '<span style="color:#27ae60;">✓</span>' : '<span style="color:#ccc;">✗</span>'}</span>
        <span style="text-align:center;">${p.edit ? '<span style="color:#27ae60;">✓</span>' : '<span style="color:#ccc;">✗</span>'}</span>
      </div>
    `;
  }

  return html;
}

function createTooltipElement(fieldElement: HTMLElement): HTMLElement {
  const tooltip = document.createElement('div');
  tooltip.id = 'sfdc-field-inspector-tooltip';

  const rect = fieldElement.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 8;
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 340);

  tooltip.style.cssText = `
    position: absolute;
    top: ${top}px;
    left: ${left}px;
    z-index: 999998;
    width: 320px;
    background: #fff;
    border: 1px solid #d8d8d8;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    overflow: hidden;
  `;

  return tooltip;
}

function removeTooltip(): void {
  currentTooltip?.remove();
  currentTooltip = null;
}

// ---------------------------------------------------------------------------
// Tooltip HTML Templates
// ---------------------------------------------------------------------------

function getLoadingHtml(label: string, value: string): string {
  return `
    <div style="padding:12px 14px; border-bottom:1px solid #eee;">
      <div style="font-weight:600; color:#333; font-size:13px;">${esc(label)}</div>
      <div style="color:#666; margin-top:2px;">${esc(value)}</div>
    </div>
    <div style="padding:16px; text-align:center; color:#888;">
      Loading field metadata...
    </div>
  `;
}

function getErrorHtml(label: string, value: string): string {
  return `
    <div style="padding:12px 14px; border-bottom:1px solid #eee;">
      <div style="font-weight:600; color:#333; font-size:13px;">${esc(label)}</div>
      <div style="color:#666; margin-top:2px;">${esc(value)}</div>
    </div>
    <div style="padding:12px 14px; color:#999; font-size:11px;">
      Could not load field metadata. Make sure the extension index is refreshed.
    </div>
  `;
}

function getFieldInfoHtml(field: FieldInfo, value: string, objectName: string): string {
  const typeDisplay = field.length ? `${field.type}(${field.length})` : field.type;
  const customBadge = field.custom ? '<span style="background:#e8f5e9;color:#2e7d32;padding:1px 5px;border-radius:3px;font-size:10px;margin-left:6px;">Custom</span>' : '';
  const requiredBadge = field.required ? '<span style="background:#fef2f2;color:#dc2626;padding:1px 5px;border-radius:3px;font-size:10px;margin-left:4px;">Required</span>' : '';

  // Custom fields need the 15-char field record ID in Setup URLs; standard fields use the API name
  const fieldRef = field.fieldId ? field.fieldId.substring(0, 15) : field.apiName;
  const viewFieldUrl = `/lightning/setup/ObjectManager/${objectName}/FieldsAndRelationships/${fieldRef}/view`;
  // FLS is shown inline in the tooltip (queried from FieldPermissions) — no fragile setup URL needed
  // "Where is this used?" page (field dependencies)
  const whereUsedUrl = `/lightning/setup/ObjectManager/${objectName}/FieldsAndRelationships/${fieldRef}/fieldDependencies`;

  let usageHtml = '';
  if (field.usedIn) {
    usageHtml = `
      <div style="padding:10px 14px; border-top:1px solid #eee; background:#fafafa;">
        <div style="font-size:10px; font-weight:600; color:#888; text-transform:uppercase; margin-bottom:6px;">Used In</div>
        <div style="display:flex; gap:12px;">
          <span style="font-size:11px; color:#555;">Layouts: <strong>${field.usedIn.layouts}</strong></span>
          <span style="font-size:11px; color:#555;">Rules: <strong>${field.usedIn.validationRules}</strong></span>
          <span style="font-size:11px; color:#555;">Flows: <strong>${field.usedIn.flows}</strong></span>
        </div>
      </div>
    `;
  }

  return `
    <div style="padding:12px 14px; border-bottom:1px solid #eee;">
      <div style="font-weight:600; color:#333; font-size:13px;">${esc(field.label)}${customBadge}${requiredBadge}</div>
      <div style="color:#666; margin-top:2px; font-size:11px;">${esc(value)}</div>
    </div>
    <div style="padding:10px 14px;">
      <table style="width:100%; font-size:11px; border-collapse:collapse;">
        <tr><td style="color:#888; padding:3px 0; width:80px;">API Name</td><td style="color:#333; font-family:monospace; font-size:11px;">${esc(field.apiName)}</td></tr>
        <tr><td style="color:#888; padding:3px 0;">Type</td><td style="color:#333;">${esc(typeDisplay)}</td></tr>
        <tr><td style="color:#888; padding:3px 0;">Object</td><td style="color:#333;">${esc(field.objectName)}</td></tr>
        ${field.helpText ? `<tr><td style="color:#888; padding:3px 0;">Help Text</td><td style="color:#555; font-style:italic;">${esc(field.helpText)}</td></tr>` : ''}
      </table>
    </div>
    ${usageHtml}
    <div style="padding:8px 14px; border-top:1px solid #eee; display:flex; gap:8px; flex-wrap:wrap;">
      <a data-url="${viewFieldUrl}" href="#" style="font-size:11px; color:#1b96ff; text-decoration:none; cursor:pointer;">View Field</a>
      <span style="color:#ddd;">|</span>
      <a data-action="show-fls" data-object="${esc(objectName)}" data-field="${esc(field.apiName)}" href="#" style="font-size:11px; color:#1b96ff; text-decoration:none; cursor:pointer;">FLS</a>
      <span style="color:#ddd;">|</span>
      <a data-url="${whereUsedUrl}" href="#" style="font-size:11px; color:#1b96ff; text-decoration:none; cursor:pointer;">Where is this used?</a>
    </div>
    <div class="sfdc-fls-panel" style="display:none; border-top:1px solid #eee; max-height:200px; overflow-y:auto;"></div>
  `;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getObjectNameFromUrl(): string {
  // Lightning URLs: /lightning/r/{ObjectName}/{recordId}/view
  const match = window.location.pathname.match(/\/lightning\/r\/(\w+)\//);
  if (match) return match[1];

  // Also try: /lightning/o/{ObjectName}/
  const match2 = window.location.pathname.match(/\/lightning\/o\/(\w+)\//);
  if (match2) return match2[1];

  return '';
}

function esc(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Message Listener (activated from popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'activateFieldInspector') {
    activate();
    sendResponse({ success: true });
  }
  if (message.action === 'deactivateFieldInspector') {
    deactivate();
    sendResponse({ success: true });
  }
  return false;
});
