# GuideMe

A Chrome extension that guides you step by step on any website by highlighting the right element to click, powered by Gemma 4 via the Gemini API.

**Status:** Stage 3 — the side panel scans the page, asks Gemma 4 (via the Gemini API) which element to use next, and highlights it with a short instruction. Add your API key under Options.

## Load it

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the GuideMe icon to open the side panel (Chrome 116+).

## API key

Copy `env.example.js` to `env.js` and set `GEMINI_API_KEY` (`env.js` is gitignored), then reload the extension. A key saved under Options overrides it.

## License

Apache-2.0 — see [LICENSE](LICENSE).
