// Permission page, opened in a normal tab by the popup.
// chrome.permissions.request() is unreliable from the action popup (the popup closes when
// Chrome's prompt takes focus, dismissing the prompt), so access is requested from here.

const params = new URLSearchParams(location.search);
const host = params.get('host') || '';
const returnTabId = Number(params.get('tab')) || null;

const hostEl = document.getElementById('host');
const button = document.getElementById('allow');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
  hostEl.textContent = 'this site';
  button.disabled = true;
  setStatus('Invalid website. Close this tab and add the site again from the WebLingo popup.', true);
} else {
  hostEl.textContent = host;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      // Must match originPatterns() in background.js and App.jsx.
      const granted = await chrome.permissions.request({ origins: [`https://*.${host}/*`, `http://*.${host}/*`] });
      if (!granted) {
        button.disabled = false;
        return setStatus('Access was not granted. Click Allow access and choose Allow in Chrome’s prompt.', true);
      }
      setStatus('Access granted. Returning to the website…');
      if (returnTabId) await chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
      const current = await chrome.tabs.getCurrent();
      if (current) chrome.tabs.remove(current.id);
    } catch (err) {
      button.disabled = false;
      setStatus(err.message, true);
    }
  });
}
