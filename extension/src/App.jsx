import { useEffect, useRef, useState } from 'react';
import './App.css';

const LANGUAGES = [
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['hi', 'Hindi'],
  ['ta', 'Tamil'],
];

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
function langName(code) {
  try {
    return displayNames.of(code);
  } catch {
    return code;
  }
}

// Must match background.js: covers the domain and all its subdomains, one pattern per scheme.
const originPatterns = (host) => [`https://*.${host}/*`, `http://*.${host}/*`];

function normalizeHost(input) {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  try {
    value = new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
  value = value.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : null;
}

function hostFromUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

// Same lookup as content.js: the most specific saved domain that covers this host.
function findRuleKey(host, rules) {
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(i).join('.');
    if (rules[key]) return key;
  }
  return null;
}

function describeStatus(page) {
  if (!page) return null;
  const from = page.source ? langName(page.source) : 'the page language';
  const to = page.target ? langName(page.target) : '';
  switch (page.status) {
    case 'detecting':
      return 'Detecting the page language…';
    case 'needs-download':
      return `Chrome needs to download the ${from} → ${to} language pack once. Click the blue WebLingo button on the page.`;
    case 'preparing':
      return page.progress != null
        ? `Downloading language pack… ${Math.round(page.progress * 100)}%`
        : 'Preparing translator…';
    case 'translating':
      return `Translating from ${from}… ${page.done}/${page.total}`;
    case 'translated':
      return `Translated from ${from}.` + (page.errors ? ` ${page.errors} pieces could not be translated.` : '');
    case 'original':
      return 'Showing the original page.';
    case 'same-language':
      return `This page is already in ${to}.`;
    case 'unsupported':
      return `Chrome can't translate ${from} → ${to}.`;
    case 'unknown-language':
      return "Couldn't detect this page's language.";
    case 'no-api':
      return "Chrome's built-in Translator isn't available here (desktop Chrome 138+ required).";
    case 'error':
      return `Error: ${page.message}`;
    default:
      return null;
  }
}

function Switch({ checked, onChange, label }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="slider" />
    </label>
  );
}

function LanguageSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {LANGUAGES.map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}

export default function App() {
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState(null);
  const [site, setSite] = useState('');
  const [target, setTarget] = useState('en');
  const [page, setPage] = useState(null);
  const [notice, setNotice] = useState('');
  const [langCheck, setLangCheck] = useState(null);
  const [access, setAccess] = useState({}); // host -> whether Chrome granted WebLingo access
  const initialized = useRef(false);
  const siteKey = normalizeHost(site);

  useEffect(() => {
    const load = () =>
      chrome.storage.sync.get(['enabled', 'rules']).then(({ enabled = true, rules = {} }) => setSettings({ enabled, rules }));
    const onChanged = (changes, area) => {
      if (area === 'sync') load();
    };
    load();
    chrome.storage.onChanged.addListener(onChanged);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Prefill the form once, from the rule that already covers this tab (if any).
  useEffect(() => {
    if (initialized.current || !settings || !tab) return;
    initialized.current = true;
    const host = hostFromUrl(tab.url);
    if (!host) return;
    const key = findRuleKey(host, settings.rules);
    setSite(key ?? host);
    if (key) setTarget(settings.rules[key].target);
  }, [settings, tab]);

  // Poll the content script for live status while the popup is open.
  useEffect(() => {
    if (!tab?.id) return;
    let alive = true;
    const poll = () =>
      chrome.tabs
        .sendMessage(tab.id, { type: 'getStatus' })
        .then((s) => alive && setPage(s))
        .catch(() => alive && setPage(null));
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [tab?.id]);

  // A rule can exist without access (e.g. the permission prompt was dismissed), so check it explicitly.
  useEffect(() => {
    if (!settings) return;
    let alive = true;
    const hosts = new Set(Object.keys(settings.rules));
    if (siteKey) hosts.add(siteKey);
    const check = () =>
      Promise.all(
        [...hosts].map(async (host) => [host, await chrome.permissions.contains({ origins: originPatterns(host) })])
      ).then((entries) => alive && setAccess(Object.fromEntries(entries)));
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => {
      alive = false;
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
    };
  }, [settings, siteKey]);

  if (!settings) return <main className="app">Loading…</main>;

  const rules = settings.rules;
  const tabHost = tab ? hostFromUrl(tab.url) : null;
  const existing = siteKey ? rules[siteKey] : null;
  const missingAccess = Boolean(existing) && access[siteKey] === false;
  const statusText = describeStatus(page);
  const canToggleView = page && ['translating', 'translated', 'original'].includes(page.status);

  const saveRules = (next) => chrome.storage.sync.set({ rules: next });

  async function addOrUpdate() {
    const host = siteKey;
    if (!host) return setNotice('Enter a website such as youtube.com.');
    await saveRules({ ...rules, [host]: { target, enabled: true } });
    if (access[host]) {
      setNotice(`${host} will be translated to ${langName(target)}.`);
    } else {
      requestAccess(host);
    }
  }

  // Opens grant.html in a tab: Chrome's permission prompt gets dismissed when requested from the popup.
  function requestAccess(host) {
    const params = new URLSearchParams({ host });
    if (tab?.id) params.set('tab', String(tab.id));
    chrome.tabs.create({ url: chrome.runtime.getURL(`grant.html?${params}`) });
  }

  async function removeRule(host) {
    const { [host]: _removed, ...rest } = rules;
    await saveRules(rest);
    chrome.permissions.remove({ origins: originPatterns(host) }).catch(() => {});
  }

  function updateRule(host, patch) {
    saveRules({ ...rules, [host]: { ...rules[host], ...patch } });
  }

  function setView(view) {
    chrome.tabs.sendMessage(tab.id, { type: 'setView', view }).catch(() => {});
  }

  async function checkLanguages() {
    if (!('Translator' in self)) {
      return setLangCheck({ error: "Chrome's built-in Translator API is not available in this browser." });
    }
    setLangCheck({ loading: true });
    try {
      const rows = await Promise.all(
        LANGUAGES.filter(([code]) => code !== 'en').map(async ([code, name]) => ({
          code,
          name,
          toEnglish: await Translator.availability({ sourceLanguage: code, targetLanguage: 'en' }),
          fromEnglish: await Translator.availability({ sourceLanguage: 'en', targetLanguage: code }),
        }))
      );
      setLangCheck({ rows });
    } catch (err) {
      setLangCheck({ error: err.message });
    }
  }

  const ruleEntries = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            文A
          </span>
          <h1>WebLingo</h1>
        </div>
        <Switch
          checked={settings.enabled}
          onChange={(enabled) => chrome.storage.sync.set({ enabled })}
          label={settings.enabled ? 'Turn WebLingo off' : 'Turn WebLingo on'}
        />
      </header>

      {!settings.enabled && <p className="banner">WebLingo is off. No pages are being translated.</p>}

      <section className="card">
        <h2>This website</h2>
        {tabHost ? (
          <>
            <div className="row">
              <input
                className="site-input"
                value={site}
                onChange={(e) => setSite(e.target.value)}
                placeholder="example.com"
                spellCheck={false}
              />
            </div>
            <div className="row">
              <span className="label">Translate to</span>
              <LanguageSelect value={target} onChange={setTarget} />
              <button
                className="primary"
                onClick={addOrUpdate}
                disabled={!missingAccess && existing && existing.target === target && existing.enabled}
              >
                {missingAccess ? 'Allow access' : existing ? 'Update' : 'Add'}
              </button>
            </div>
            {missingAccess && (
              <p className="warning">
                WebLingo doesn't have access to {siteKey} yet. Click Allow access: a WebLingo tab opens where you can
                grant it.
              </p>
            )}
            {statusText && <p className="status">{statusText}</p>}
            {canToggleView && (
              <button className="secondary" onClick={() => setView(page.status === 'original' ? 'translated' : 'original')}>
                {page.status === 'original' ? 'Show translation' : 'Show original'}
              </button>
            )}
          </>
        ) : (
          <p className="muted">Open a website to add it.</p>
        )}
        {notice && <p className="notice">{notice}</p>}
      </section>

      <section className="card">
        <h2>Websites ({ruleEntries.length})</h2>
        {ruleEntries.length === 0 ? (
          <p className="muted">No websites yet. Open one and click Add.</p>
        ) : (
          <ul className="rules">
            {ruleEntries.map(([host, rule]) => (
              <li key={host} className={rule.enabled ? '' : 'disabled'}>
                <span className="host" title={host}>
                  {host}
                </span>
                {access[host] === false && (
                  <button className="tag" onClick={() => requestAccess(host)} title="WebLingo has no access to this site">
                    Allow
                  </button>
                )}
                <LanguageSelect value={rule.target} onChange={(t) => updateRule(host, { target: t })} />
                <Switch
                  checked={rule.enabled}
                  onChange={(enabled) => updateRule(host, { enabled })}
                  label={`Translate ${host}`}
                />
                <button className="icon" onClick={() => removeRule(host)} aria-label={`Remove ${host}`} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <button className="link" onClick={checkLanguages}>
          Check language support
        </button>
        {langCheck?.loading && <p className="muted">Checking…</p>}
        {langCheck?.error && <p className="notice">{langCheck.error}</p>}
        {langCheck?.rows && (
          <table className="langs">
            <thead>
              <tr>
                <th>Language</th>
                <th>→ English</th>
                <th>English →</th>
              </tr>
            </thead>
            <tbody>
              {langCheck.rows.map((r) => (
                <tr key={r.code}>
                  <td>{r.name}</td>
                  <td className={r.toEnglish}>{r.toEnglish}</td>
                  <td className={r.fromEnglish}>{r.fromEnglish}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
