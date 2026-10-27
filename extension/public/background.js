// WebLingo service worker.
// Keeps the registered content script in sync with the saved website rules, so the
// content script only ever runs on sites the user added (and granted access to).

const SCRIPT_ID = 'weblingo-content';

// One pattern per scheme: Chrome rejects a "*://" request unless the manifest lists "*://" itself.
const originPatterns = (host) => [`https://*.${host}/*`, `http://*.${host}/*`];

async function syncContentScripts() {
  const { enabled = true, rules = {} } = await chrome.storage.sync.get(['enabled', 'rules']);

  const matches = [];
  if (enabled) {
    for (const [host, rule] of Object.entries(rules)) {
      if (!rule.enabled) continue;
      const patterns = originPatterns(host);
      if (await chrome.permissions.contains({ origins: patterns })) matches.push(...patterns);
    }
  }

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ['content.js'],
      matches,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);

  // Registered scripts only run on future page loads; start them in tabs that are already open.
  // content.js ignores a second injection, and running copies react to storage changes themselves.
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})
    )
  );
}

// Serialize syncs so overlapping storage/permission events can't race each other.
let syncChain = Promise.resolve();
function queueSync() {
  syncChain = syncChain.then(syncContentScripts).catch((err) => console.error('[WebLingo] sync failed:', err));
  return syncChain;
}

chrome.runtime.onInstalled.addListener(queueSync);
chrome.runtime.onStartup.addListener(queueSync);
chrome.permissions.onAdded.addListener(queueSync);
chrome.permissions.onRemoved.addListener(queueSync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.rules || changes.enabled)) queueSync();
});
