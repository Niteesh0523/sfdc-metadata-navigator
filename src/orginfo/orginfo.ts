/**
 * SFDC Metadata Navigator - Org Info Dashboard Controller
 *
 * Fetches and displays:
 * - Org identity (name, ID, type, instance)
 * - Current user info (name, username, email, profile, role)
 * - API limits (daily API calls, SOQL queries, etc.)
 * - Storage usage with clickable breakdown (data by object, files by type)
 */

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  document.getElementById('refresh-btn')!.addEventListener('click', loadDashboard);
  loadDashboard();
}

async function loadDashboard(): Promise<void> {
  const loading = document.getElementById('loading-panel')!;
  const error = document.getElementById('error-panel')!;
  const dashboard = document.getElementById('dashboard')!;

  loading.style.display = 'flex';
  error.style.display = 'none';
  dashboard.style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'getOrgInfo' });

    if (response?.error) {
      showError(response.error);
      return;
    }

    renderDashboard(response);
    loading.style.display = 'none';
    dashboard.style.display = 'block';
  } catch (e: unknown) {
    showError(e instanceof Error ? e.message : 'Failed to load org info.');
  }
}

function showError(message: string): void {
  document.getElementById('loading-panel')!.style.display = 'none';
  document.getElementById('error-panel')!.style.display = 'flex';
  document.getElementById('error-text')!.textContent = message;
}

// ---------------------------------------------------------------------------
// Render Dashboard
// ---------------------------------------------------------------------------

function renderDashboard(data: any): void {
  // Org info
  setText('org-name', data.org?.Name || '—');
  setText('org-id', data.org?.Id || '—');
  setText('org-type', data.org?.OrganizationType || '—');
  setText('org-instance', data.org?.InstanceName || '—');
  setText('api-version', data.apiVersion || '—');
  setText('org-namespace', data.org?.NamespacePrefix || 'None');

  // User info
  setText('user-name', data.user?.Name || '—');
  setText('user-username', data.user?.Username || '—');
  setText('user-email', data.user?.Email || '—');
  setText('user-profile', data.user?.ProfileName || '—');
  setText('user-role', data.user?.RoleName || 'None');
  setText('user-id', data.user?.Id || '—');

  // API Limits
  renderLimits('limits-grid', data.limits, [
    { key: 'DailyApiRequests', label: 'Daily API Requests' },
    { key: 'DailyBulkApiRequests', label: 'Bulk API Requests' },
    { key: 'DailyAsyncApexExecutions', label: 'Async Apex Executions' },
    { key: 'DailyWorkflowEmails', label: 'Workflow Emails' },
    { key: 'SingleEmail', label: 'Single Emails (24h)' },
    { key: 'StreamingApiConcurrentClients', label: 'Streaming API Clients' },
  ]);

  // Storage (clickable for breakdown)
  renderStorageSection(data.limits);
}

// ---------------------------------------------------------------------------
// API Limits Rendering
// ---------------------------------------------------------------------------

function renderLimits(
  containerId: string,
  limits: Record<string, { Max: number; Remaining: number }> | undefined,
  items: Array<{ key: string; label: string }>
): void {
  const container = document.getElementById(containerId)!;
  container.innerHTML = '';

  if (!limits) {
    container.innerHTML = '<p style="color:#888;font-size:13px;">Limits data unavailable</p>';
    return;
  }

  for (const item of items) {
    const limit = limits[item.key];
    if (!limit) continue;

    const used = limit.Max - limit.Remaining;
    const percent = limit.Max > 0 ? Math.round((used / limit.Max) * 100) : 0;
    const colorClass = percent > 90 ? 'red' : percent > 70 ? 'yellow' : 'green';

    const el = document.createElement('div');
    el.className = 'limit-item';
    el.innerHTML = `
      <span class="limit-name">${item.label}</span>
      <div class="limit-bar-container">
        <div class="limit-bar ${colorClass}" style="width: ${percent}%"></div>
      </div>
      <span class="limit-text">${formatNumber(used)} / ${formatNumber(limit.Max)} (${percent}%)</span>
    `;
    container.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Storage Section (Clickable with Breakdown)
// ---------------------------------------------------------------------------

function renderStorageSection(limits: Record<string, { Max: number; Remaining: number }> | undefined): void {
  const container = document.getElementById('storage-grid')!;
  container.innerHTML = '';

  if (!limits) {
    container.innerHTML = '<p style="color:#888;font-size:13px;">Storage data unavailable</p>';
    return;
  }

  // Data Storage
  const dataLimit = limits['DataStorageMB'];
  if (dataLimit) {
    container.appendChild(createStorageItem('Data Storage', dataLimit, 'data'));
  }

  // File Storage
  const fileLimit = limits['FileStorageMB'];
  if (fileLimit) {
    container.appendChild(createStorageItem('File Storage', fileLimit, 'file'));
  }
}

function createStorageItem(
  label: string,
  limit: { Max: number; Remaining: number },
  type: 'data' | 'file'
): HTMLElement {
  const used = limit.Max - limit.Remaining;
  const percent = limit.Max > 0 ? Math.round((used / limit.Max) * 100) : 0;
  const colorClass = percent > 90 ? 'red' : percent > 70 ? 'yellow' : 'green';

  const el = document.createElement('div');
  el.className = 'limit-item storage-item clickable';
  el.innerHTML = `
    <div class="storage-header">
      <span class="limit-name">${label}</span>
      <span class="storage-expand-hint">Click for details</span>
    </div>
    <div class="limit-bar-container">
      <div class="limit-bar ${colorClass}" style="width: ${percent}%"></div>
    </div>
    <span class="limit-text">${used} MB / ${limit.Max} MB (${percent}%)</span>
    <div class="storage-breakdown" style="display:none">
      <div class="breakdown-loading">Loading breakdown...</div>
    </div>
  `;

  let loaded = false;
  el.addEventListener('click', async (e) => {
    // Don't toggle if click was on a file type sub-row
    if ((e.target as HTMLElement).closest('.clickable-row') || (e.target as HTMLElement).closest('.file-object-breakdown')) {
      return;
    }
    const breakdown = el.querySelector('.storage-breakdown') as HTMLElement;
    if (breakdown.style.display === 'none') {
      breakdown.style.display = 'block';
      if (!loaded) {
        loaded = true;
        await loadStorageBreakdown(breakdown, type);
      }
    } else {
      breakdown.style.display = 'none';
    }
  });

  return el;
}

async function loadStorageBreakdown(container: HTMLElement, type: 'data' | 'file'): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getStorageBreakdown', type });

    if (response?.error) {
      container.innerHTML = `<p class="breakdown-error">${response.error}</p>`;
      return;
    }

    renderBreakdown(container, response.items, type);
  } catch {
    container.innerHTML = '<p class="breakdown-error">Failed to load breakdown.</p>';
  }
}

function renderBreakdown(
  container: HTMLElement,
  items: Array<{ name: string; count: number; size: number }>,
  type: 'data' | 'file'
): void {
  if (!items || items.length === 0) {
    container.innerHTML = '<p class="breakdown-empty">No breakdown data available.</p>';
    return;
  }

  // Sort by size descending
  items.sort((a, b) => b.size - a.size);

  // Calculate total for percentages
  const total = items.reduce((sum, item) => sum + item.size, 0);

  // Color palette
  const colors = ['#3498db', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'];

  // Map SF file type codes to readable names
  const fileTypeNames: Record<string, string> = {
    'POWER_POINT_X': 'PowerPoint',
    'POWER_POINT': 'PowerPoint',
    'EXCEL_X': 'Excel',
    'EXCEL_M': 'Excel (Macro)',
    'WORD_X': 'Word',
    'WORD': 'Word',
    'PDF': 'PDF',
    'ZIP': 'ZIP Archive',
    'CSV': 'CSV',
    'PNG': 'PNG Image',
    'JPG': 'JPEG Image',
    'JPEG': 'JPEG Image',
    'GIF': 'GIF Image',
    'MP4': 'MP4 Video',
    'MOV': 'MOV Video',
    'M4V': 'M4V Video',
    'PSD': 'Photoshop',
    'PPSX': 'PowerPoint Show',
    'MSG': 'Outlook Email',
    'UNKNOWN': 'Other/Unknown',
    'TEXT': 'Text File',
    'HTML': 'HTML',
    'XML': 'XML',
    'JSON': 'JSON',
    'SVG': 'SVG Image',
    'TIFF': 'TIFF Image',
  };

  let html = '<div class="breakdown-list">';

  html += `<div class="breakdown-header">
    <span class="breakdown-col-name">${type === 'data' ? 'Object' : 'File Type'}</span>
    <span class="breakdown-col-count">${type === 'data' ? 'Records' : 'Files'}</span>
    <span class="breakdown-col-size">Size</span>
    <span class="breakdown-col-pct">%</span>
  </div>`;

  items.forEach((item, i) => {
    const pct = total > 0 ? Math.round((item.size / total) * 100) : 0;
    const color = colors[i % colors.length];
    let sizeStr: string;
    if (type === 'data') {
      // Salesforce counts ~2KB per record for storage
      const estimatedMB = (item.count * 2) / 1024;
      sizeStr = formatMB(estimatedMB);
    } else {
      sizeStr = formatMB(item.size);
    }
    const displayName = type === 'file' ? (fileTypeNames[item.name] || item.name) : item.name;

    html += `<div class="breakdown-row${type === 'file' ? ' clickable-row' : ''}" data-filetype="${esc(item.name)}">
      <span class="breakdown-col-name">
        <span class="breakdown-dot" style="background:${color}"></span>
        ${esc(displayName)}
        ${type === 'file' ? '<span class="drill-hint">▸</span>' : ''}
      </span>
      <span class="breakdown-col-count">${formatNumber(item.count)}</span>
      <span class="breakdown-col-size">${sizeStr}</span>
      <span class="breakdown-col-pct">
        <div class="breakdown-mini-bar" style="width:${pct}%;background:${color}"></div>
        ${pct}%
      </span>
    </div>
    <div class="file-object-breakdown" data-for="${esc(item.name)}" style="display:none"></div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  // Add click handlers for file type rows
  if (type === 'file') {
    container.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        e.stopPropagation(); // Prevent parent storage item from toggling
        const fileType = (row as HTMLElement).dataset.filetype!;
        const subContainer = container.querySelector(`.file-object-breakdown[data-for="${fileType}"]`) as HTMLElement;
        if (!subContainer) return;

        if (subContainer.style.display === 'none') {
          subContainer.style.display = 'block';
          if (!subContainer.dataset.loaded) {
            subContainer.dataset.loaded = '1';
            subContainer.innerHTML = '<div class="breakdown-loading">Loading objects...</div>';
            await loadFileTypeObjects(subContainer, fileType);
          }
        } else {
          subContainer.style.display = 'none';
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// File Type → Object Drill-down
// ---------------------------------------------------------------------------

async function loadFileTypeObjects(container: HTMLElement, fileType: string): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getFileTypeObjects', fileType });

    if (response?.error) {
      container.innerHTML = `<p class="breakdown-error">${response.error}</p>`;
      return;
    }

    if (!response?.items || response.items.length === 0) {
      container.innerHTML = '<p class="breakdown-empty" style="padding:8px 16px;">No linked objects found.</p>';
      return;
    }

    const items: Array<{ name: string; count: number }> = response.items;
    items.sort((a, b) => b.count - a.count);
    const total = items.reduce((sum, it) => sum + it.count, 0);
    const colors = ['#5dade2', '#48c9b0', '#f5b041', '#eb984e', '#af7ac5', '#45b39d', '#ec7063', '#5499c7'];

    let html = '<div class="sub-breakdown">';
    html += '<p class="sub-breakdown-note">Where these files are shared (one file can appear in multiple places)</p>';
    html += '<div class="sub-breakdown-header"><span>Object</span><span>Links</span><span>%</span></div>';

    items.forEach((item, i) => {
      const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
      const color = colors[i % colors.length];
      html += `<div class="sub-breakdown-row">
        <span class="sub-name"><span class="breakdown-dot" style="background:${color}"></span>${esc(item.name)}</span>
        <span class="sub-count">${formatNumber(item.count)}</span>
        <span class="sub-pct"><div class="breakdown-mini-bar" style="width:${pct}%;background:${color}"></div>${pct}%</span>
      </div>`;
    });

    html += '</div>';
    container.innerHTML = html;
  } catch {
    container.innerHTML = '<p class="breakdown-error">Failed to load object breakdown.</p>';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setText(id: string, value: string): void {
  document.getElementById(id)!.textContent = value;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatMB(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(1) + ' MB';
}

function esc(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);
