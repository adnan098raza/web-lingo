# WebLingo

A Chrome extension that automatically translates the websites you choose, using Chrome's built-in, on-device [Translator API](https://developer.chrome.com/docs/ai/translator-api).

- **Free**: no API key, account or server.
- **Private**: page text is translated on your computer and never sent anywhere.
- **Per-site rules**: for example, translate `amazon.de` to English and leave every other site alone.

> **Status: early development.** Website rules, language support detection and the popup work. Getting site access and translating a page end to end are still being tested.

## Features

- Add a website and pick a target language. WebLingo translates it automatically on every visit.
- A rule covers the domain and all its subdomains (`example.de` also covers `news.example.de`).
- One switch turns WebLingo on or off everywhere, and each site has its own switch. Turning either off restores the original text immediately, without a reload.
- **Show original / Show translation** button in the popup.
- Text that loads later (infinite scroll, single-page apps) is translated as it appears, in batches.
- Repeated text is translated once and cached.
- A language support check shows which languages Chrome can translate on your machine.
- WebLingo only gets access to the sites you add, and only after you approve each one.

Available target languages: English, German, French, Spanish, Italian, Portuguese, Hindi, Tamil.

## Requirements

- Desktop Google Chrome **138 or newer**. The Translator API isn't available on mobile or in other browsers.
- [Node.js](https://nodejs.org/) 20.19 or newer, to build the extension.

## Installation

```powershell
git clone https://github.com/adnan098raza/web-lingo.git
cd web-lingo\extension
npm install
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `web-lingo\extension\dist` folder.
4. Pin WebLingo from the puzzle icon in the toolbar.

## Usage

1. Open a website you want translated, for example `https://www.tagesschau.de`.
2. Click the WebLingo icon, choose a language and click **Add**.
3. A WebLingo tab opens. Click **Allow access** and approve Chrome's prompt.
4. The first time you use a language pair (for example German → English), a blue **WebLingo · Translate page** button appears at the bottom right of the page. Click it once so Chrome downloads that language pack.
5. After that, the site is translated automatically whenever you visit it.

## Project structure

```text
extension/
├── public/                 Copied unchanged into dist/
│   ├── manifest.json       Manifest V3 config and permissions
│   ├── background.js       Service worker: runs content.js only on sites you added
│   ├── content.js          Detects the page language, translates text, watches for new content
│   ├── grant.html          Page that asks Chrome for access to a site
│   └── grant.js
├── src/                    Popup UI (React)
│   ├── App.jsx
│   ├── App.css
│   └── main.jsx
├── index.html              Popup entry point
├── vite.config.js
└── package.json
```

## How it works

1. **Rules** are saved with `chrome.storage.sync`, so they follow your Chrome profile.
2. **The service worker** registers `content.js` only for sites that have a rule and access you approved. It updates that registration whenever rules or permissions change.
3. **The content script** detects the page language with `chrome.i18n.detectLanguage` and creates a `Translator` for that language pair. It translates the page's text nodes in place, keeping each original so it can be restored instantly.
4. **A `MutationObserver`** picks up content added later and translates it in batches.

## Development

```powershell
cd extension
npm run dev      # rebuilds dist/ automatically when files change
```

After a change:

- Popup and `grant.html` changes appear the next time you open them.
- Changes to `manifest.json`, `background.js` or `content.js` need a reload: click **↻** on the WebLingo card in `chrome://extensions`, then reload the page you're testing.

## Roadmap

- [ ] Confirm site access and end-to-end translation
- [ ] Translate whole sentences across elements for better quality
- [ ] Translate attributes such as `placeholder`, `title` and `alt`
- [ ] Shadow DOM and iframe support
- [ ] Page-level exclusions within a site
- [ ] Extension icons
- [ ] Privacy policy and Chrome Web Store release

## License

No license has been chosen yet.
