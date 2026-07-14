# Privacy Policy — SFDC Metadata Navigator

_Last updated: June 2026_

## Summary

SFDC Metadata Navigator does not collect, transmit, store, or sell any user data to any external service. All data stays in your browser.

## What the extension accesses

- **Salesforce session cookie (`sid`)**: Read locally to authenticate API calls to your own Salesforce org. The cookie value is never transmitted anywhere except to Salesforce's own APIs, exactly as your browser already does when you use Salesforce.
- **Salesforce metadata and record data**: Fetched from your org's Salesforce REST and Tooling APIs and cached in Chrome's local storage on your machine, solely to power search, scanning, and dashboard features.
- **Active tab URL**: Read to detect whether you are on a Salesforce page and to identify your org.

## What the extension does NOT do

- No data is sent to any third-party server. There is no backend. All processing happens locally in your browser.
- No analytics, tracking, or telemetry of any kind.
- No data is shared, sold, or used for advertising.

## Data storage

Cached metadata indexes and settings are stored using Chrome's `storage` API on your device only. Uninstalling the extension removes all stored data.

## Permissions justification

| Permission | Why it is needed |
|---|---|
| `cookies` | Read your existing Salesforce session cookie to authenticate API calls without a separate login |
| `tabs` / `activeTab` | Detect the active Salesforce org and open results in new tabs |
| `scripting` | Inject the field inspector and org detection script into Salesforce pages |
| `storage` | Cache the metadata search index and your settings locally |
| Host permissions (`*.salesforce.com`, `*.force.com`, etc.) | Communicate with Salesforce APIs and run on Salesforce pages only |

## Contact

For questions about this policy, open an issue on the GitHub repository.
