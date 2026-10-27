// WebLingo content script.
// Translates the page in place with Chrome's on-device Translator API and keeps the
// original text so it can be restored instantly without a reload.
(() => {
  if (window.__webLingoLoaded) return;
  window.__webLingoLoaded = true;

  const CONCURRENCY = 4;
  const FLUSH_DELAY_MS = 300;
  const SAMPLE_CHARS = 3000;
  const MAX_CACHE_ENTRIES = 5000;
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe',
    '[translate="no"]', '.notranslate', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  const HAS_LETTER = /\p{L}/u;
  const EDGE_SPACE = /^(\s*)([\s\S]*?)(\s*)$/;

  // Reported to the popup via getStatus.
  const state = {
    status: 'idle', // idle | detecting | needs-download | preparing | translating | translated | original | same-language | unsupported | unknown-language | no-api | error | off
    source: null,
    target: null,
    done: 0,
    total: 0,
    errors: 0,
    progress: null,
    message: null,
  };

  // Bumped whenever translation must stop (restore, settings change); stale async work checks it.
  let runId = 0;
  let translator = null;
  let translatorKey = null;
  const caches = new Map(); // "de>en" -> Map(original text -> Promise<translated text>)
  const originals = new Map(); // Text node -> original value, for restoring
  const written = new WeakMap(); // Text node -> value WebLingo wrote, to ignore our own mutations
  const pending = new Set();
  let flushTimer = null;
  let observer = null;

  const baseLang = (code) => code.toLowerCase().split('-')[0];
  const normalizeLang = (code) => (baseLang(code) === 'zh' ? code : baseLang(code));

  function setStatus(status) {
    state.status = status;
  }

  function fail(err) {
    console.warn('[WebLingo]', err);
    state.message = err?.message || String(err);
    setStatus('error');
    ui.hide();
  }

  // ---------- Settings ----------

  async function readRule() {
    const { enabled = true, rules = {} } = await chrome.storage.sync.get(['enabled', 'rules']);
    if (!enabled) return null;
    // Most specific match first: "news.example.de" before "example.de".
    const parts = location.hostname.toLowerCase().split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const rule = rules[parts.slice(i).join('.')];
      if (rule) return rule.enabled ? rule : null;
    }
    return null;
  }

  async function applySettings() {
    const rule = await readRule();
    if (!rule) return stop();
    if (state.target === rule.target && state.status !== 'off') return;
    restore();
    state.target = rule.target;
    start(); // not awaited: translation runs in the background, guarded by runId
  }

  let settingsChain = Promise.resolve();
  function queueApplySettings() {
    settingsChain = settingsChain.then(applySettings).catch(fail);
  }

  // ---------- Translation ----------

  async function detectSource() {
    const htmlLang = document.documentElement.lang;
    const sample = (document.body?.innerText || '').slice(0, SAMPLE_CHARS);
    try {
      const { isReliable, languages } = await chrome.i18n.detectLanguage(sample);
      const top = languages?.[0]?.language;
      if (top && top !== 'und' && (isReliable || !htmlLang)) return normalizeLang(top);
    } catch {
      // fall back to the page's declared language
    }
    return htmlLang ? normalizeLang(htmlLang) : null;
  }

  async function start() {
    const run = ++runId;
    Object.assign(state, { done: 0, total: 0, errors: 0, progress: null, message: null });
    setStatus('detecting');

    if (!('Translator' in self)) return setStatus('no-api');

    const source = await detectSource();
    if (run !== runId) return;
    state.source = source;
    if (!source) return setStatus('unknown-language');
    if (baseLang(source) === baseLang(state.target)) return setStatus('same-language');

    let availability;
    try {
      availability = await Translator.availability({ sourceLanguage: source, targetLanguage: state.target });
    } catch (err) {
      return fail(err);
    }
    if (run !== runId) return;

    if (availability === 'unavailable') return setStatus('unsupported');
    if (availability === 'available') return createAndTranslate(run);

    // Downloading a language pack needs a click on the page (Chrome requires user activation).
    setStatus('needs-download');
    ui.show(`Translate page (${source} → ${state.target})`, () => createAndTranslate(run));
  }

  async function createAndTranslate(run) {
    if (run !== runId) return;
    const key = `${state.source}>${state.target}`;
    if (translatorKey !== key) {
      setStatus('preparing');
      try {
        translator?.destroy();
        translator = null;
        translatorKey = null;
        const created = await Translator.create({
          sourceLanguage: state.source,
          targetLanguage: state.target,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              state.progress = e.loaded;
              ui.show(`Downloading language pack… ${Math.round(e.loaded * 100)}%`);
            });
          },
        });
        if (run !== runId) return created.destroy();
        translator = created;
        translatorKey = key;
      } catch (err) {
        return fail(err);
      }
    }

    ui.hide();
    setStatus('translating');
    observe();
    await translateNodes(collectTextNodes(document.body), run);
    if (run === runId && state.status === 'translating') setStatus('translated');
  }

  function translateText(text) {
    let cache = caches.get(translatorKey);
    if (!cache) caches.set(translatorKey, (cache = new Map()));
    // Caching the promise also de-duplicates identical requests that are still in flight.
    if (cache.has(text)) return cache.get(text);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    const promise = translator.translate(text).catch((err) => {
      cache.delete(text);
      throw err;
    });
    cache.set(text, promise);
    return promise;
  }

  async function translateNode(node, run) {
    const value = node.nodeValue;
    if (!node.isConnected || written.get(node) === value) return;
    const [, lead, core, trail] = EDGE_SPACE.exec(value);
    if (!HAS_LETTER.test(core)) return;

    let result;
    try {
      result = await translateText(core);
    } catch (err) {
      state.errors++;
      return;
    }
    // Skip if we were cancelled or the page changed this text while we waited.
    if (run !== runId || node.nodeValue !== value) return;

    const output = lead + result + trail;
    originals.set(node, value);
    written.set(node, output);
    node.nodeValue = output;
  }

  async function translateNodes(nodes, run) {
    state.total += nodes.length;
    let next = 0;
    const worker = async () => {
      while (next < nodes.length && run === runId) {
        await translateNode(nodes[next++], run);
        state.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  // ---------- DOM ----------

  function isSkipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !el || Boolean(el.closest(SKIP_SELECTOR)) || el.isContentEditable;
  }

  function collectTextNodes(root, into = []) {
    if (!root || isSkipped(root)) return into;
    if (root.nodeType === Node.TEXT_NODE) {
      if (HAS_LETTER.test(root.nodeValue)) into.push(root);
      return into;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return HAS_LETTER.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) into.push(walker.currentNode);
    return into;
  }

  function observe() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          if (written.get(m.target) !== m.target.nodeValue) pending.add(m.target);
        } else {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) pending.add(n);
          }
        }
      }
      // Throttle: at most one batch per FLUSH_DELAY_MS, however busy the page is.
      if (pending.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function flush() {
    flushTimer = null;
    const roots = [...pending];
    pending.clear();

    const nodes = new Set();
    for (const root of roots) {
      if (root.isConnected) for (const n of collectTextNodes(root)) nodes.add(n);
    }
    for (const node of originals.keys()) if (!node.isConnected) originals.delete(node);

    if (nodes.size) translateNodes([...nodes], runId);
  }

  function restore() {
    runId++;
    observer?.disconnect();
    observer = null;
    clearTimeout(flushTimer);
    flushTimer = null;
    pending.clear();
    for (const [node, original] of originals) {
      // Only undo text we wrote; if the page replaced it since, leave the page's version.
      if (node.isConnected && node.nodeValue === written.get(node)) node.nodeValue = original;
    }
    originals.clear();
    ui.hide();
  }

  function stop() {
    restore();
    state.target = null;
    setStatus('off');
  }

  function setView(view) {
    if (!state.target) return;
    if (view === 'original') {
      restore();
      setStatus('original');
    } else {
      start();
    }
  }

  // ---------- On-page button ----------

  const ui = (() => {
    let host = null;
    let button = null;

    function ensure() {
      if (host) return;
      host = document.createElement('div');
      host.setAttribute('translate', 'no');
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          button {
            position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
            font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
            color: #fff; background: #2563eb; border: 0; border-radius: 999px;
            padding: 10px 16px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); cursor: pointer;
          }
          button:hover:not(:disabled) { background: #1d4ed8; }
          button:disabled { cursor: default; opacity: 0.95; }
        </style>
        <button type="button"></button>`;
      button = shadow.querySelector('button');
    }

    return {
      show(text, onClick) {
        ensure();
        button.textContent = `WebLingo · ${text}`;
        button.disabled = !onClick;
        button.onclick = onClick
          ? () => {
              button.onclick = null;
              onClick();
            }
          : null;
        // Attached outside <body>, so the MutationObserver never sees it.
        if (!host.isConnected) document.documentElement.append(host);
      },
      hide() {
        host?.remove();
      },
    };
  })();

  // ---------- Wiring ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'getStatus') {
      sendResponse({ ...state, host: location.hostname });
    } else if (msg?.type === 'setView') {
      setView(msg.view);
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.rules || changes.enabled)) queueApplySettings();
  });

  queueApplySettings();
})();
