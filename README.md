<div align="center">

<img src="icons/logo.svg" alt="GuideMe logo" width="96" height="96">

# GuideMe

### Show me where to click.

**An open-source Chrome extension that guides anyone through any website, step by step, in English or Urdu, powered by Google's open-weight Gemma 4.**

<p>
  <img alt="Chrome Extension" src="https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white">
  <img alt="Gemma 4" src="https://img.shields.io/badge/Model-Gemma%204-8E75B2?logo=googlegemini&logoColor=white">
  <img alt="Languages" src="https://img.shields.io/badge/Languages-English%20%7C%20Urdu%20%7C%20Roman%20Urdu-1a7f37">
  <img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-D22128?logo=apache&logoColor=white">
  <img alt="Hacktoberfest" src="https://img.shields.io/badge/Hacktoberfest-Hack%20Day%20Faisalabad%202026-FF8AE2?logo=hacktoberfest&logoColor=white">
</p>

<p>
  <a href="https://huzaifa282.github.io/GuideMe/"><b>Setup page</b></a> ·
  <a href="#-demo">Demo</a> ·
  <a href="#-how-it-works">How it works</a> ·
  <a href="#-tech-stack">Tech stack</a> ·
  <a href="#-install-and-run">Install</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

</div>

---

## 📖 Table of contents

1. [The problem](#-the-problem)
2. [Demo](#-demo)
3. [How it works](#-how-it-works)
4. [Features](#-features)
5. [Tech stack](#-tech-stack)
6. [Install and run](#-install-and-run)
7. [Project structure](#-project-structure)
8. [Privacy](#-privacy)
9. [Known limitations](#-known-limitations)
10. [Roadmap](#-roadmap)
11. [License](#-license)

---

## 🎯 The problem

Students, parents and first-time users get lost on university and government portals. Menus hide what you need, the right link sits in the footer, and one wrong click sends you back to the start. A good example is applying for undergraduate admission on the UAF portal: the steps exist, but finding them is the hard part.

AI agents solve this by doing the task *for* you. GuideMe does the opposite: it **teaches you to do it yourself**. It points at the right button, tells you in a sentence what to do and why, and waits for you to click.

| | AI agents | **GuideMe** |
|---|---|---|
| Who clicks? | The agent | **You** |
| What you learn | Nothing, it just happens | **Where things are and why** |
| Control | Hand over your browser | **You stay in charge** |
| Next time | You need the agent again | **You can do it alone** |

## 🎬 Demo


https://github.com/user-attachments/assets/fbe5b262-e18e-4a65-aa10-0c51aa0bc00d



## ⚙️ How it works

GuideMe runs as a side panel (the "orchestrator") next to the page. Each step goes through the same pipeline:

```
                    +-------------------+
   "How do I apply  |   Side panel       |   goal, step number, history
    for admission?" |   (orchestrator)  |   saved for the session
                    +---------+---------+
                              |
                              v
   +----------------------------------------------------------+
   | 1. Page scanner  (content script)                        |
   |    interactive elements + info snippets (phone, email,   |
   |    address, headings) + hidden dropdown items            |
   +--------------------------+-------------------------------+
                              |
                              v
   +----------------------------------------------------------+
   | 2. Local relevance ranker                                |
   |    goal words + synonyms -> top 60 items (+ everything   |
   |    already in view)                                      |
   +--------------------------+-------------------------------+
                              |
                              v
   +----------------------------------------------------------+
   | 3. Gemma 4 Navigator  (Gemini API)                       |
   |    - verifies the last click: on track / off track / done|
   |    - picks the ONE next element                          |
   |    - writes a short instruction in the user's language   |
   |    - prefetches the best item of each relevant dropdown  |
   +--------------------------+-------------------------------+
                              |
                              +------> 3b. Look-ahead scout (background)
                              |        fetches the page the highlighted link
                              |        leads to, asks Gemma for the step
                              |        there, up to 3 pages ahead
                              v
                              |
                              v
   +----------------------------------------------------------+
   | 4. Highlight overlay  (Shadow DOM)                       |
   |    spotlight + ring + step badge + instruction card      |
   +--------------------------+-------------------------------+
                              |
                    you click the highlighted item
                              |
                              v
        page changes  -->  rescan  -->  look-ahead answer ready?
                                        yes: highlight instantly
                                        no:  back to step 3
        (up to 12 steps, with the history of what you did)
```

<details>
<summary><b>Pipeline details (click to expand)</b></summary>

<br>

- **Goal understanding.** A small Gemma call turns the goal (English, Urdu script or Roman Urdu) into a short English task and keywords. The panel shows it ("Understood: Apply for undergraduate admission") and the ranker uses the keywords, so Urdu goals rank as well as English ones.
- **Scanner.** The content script lists visible buttons, links, inputs, selects and text fields across the *whole* page (not just the viewport), tags each with a zone (header, main, footer, dialog), records **where each link goes** and **which section it sits in**, and also collects non-clickable info: phone numbers, emails, addresses, headings and short blocks of page text (fees, dates, requirements). Form fields are described by their labels; what you type is never sent. Links inside hover menus are included, together with the menu that opens them. If a modal is open, only the modal is sent.
- **Ranker.** To keep requests small and fast, items are scored locally against the goal and Gemma's keywords (word overlap on the text, the link path and the section, plus a synonym map that includes Roman Urdu words such as *dakhla* and *natija*). The 60 best items go to the model, together with what is currently on screen; page text is only sent when it matches the goal.
- **Navigator.** One Gemma 4 call does two jobs: it judges whether your last click moved you toward the goal and chooses the next element. It also pre-picks the best item inside each relevant dropdown, so when you hover a menu the answer is already there.
- **Highlight.** A Shadow DOM overlay dims the page, rings the target, numbers the step and shows the instruction at the edge of the screen. Hidden dropdown items are opened for you, or the menu trigger is highlighted with "Hover X, then click Y".
- **Look-ahead scout.** While you read the current step, the side panel fetches the page the highlighted link leads to (as plain HTML, without your cookies), extracts its links, buttons and text, and asks Gemma what you will need to do there, chaining up to three pages ahead. The upcoming steps appear in the panel as **Up next**, the page card shows **Next: ...**, and when you arrive the highlight appears **instantly** (marked *Instant*), with no wait for the model. Links that could change something (log out, delete) and files are never followed; pages built entirely by JavaScript fall back to a normal Gemma call.
- **Loop across pages.** The side panel keeps the goal, step number, history and step timeline in `chrome.storage.session`. After your click it waits for the next page, rescans, and either uses the look-ahead answer or asks the Navigator again. If you wander off on your own, that is recorded too, so Gemma can lead you back. The session ends when the goal is done, after 12 steps, or when you press **Stop**.
- **Resilience.** Failed calls (HTTP 5xx, 429 rate limits, network errors) are retried after 1 s, 3 s and 6 s. A rate limit switches models at once (each model has its own quota); otherwise two failures on one model switch between `gemma-4-26b-a4b-it` and `gemma-4-31b-it` for the rest of the session. Gemma's answer is read with a brace-aware JSON parser, so extra words around the JSON never break a step. When everything fails, a plain-language message and a **Retry** button appear, and Retry resumes from the current step.

</details>

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🌐 | **Roman Urdu, Urdu and English goals** | Type what you want in the language you think in. Gemma replies in the same language, and the instruction card supports right-to-left text. |
| 🔮 | **Look-ahead** | GuideMe reads the next pages in the background, shows the upcoming steps before you get there, and highlights them instantly when you arrive. |
| 🪧 | **Step timeline** | The side panel shows done, current and upcoming steps instead of a log; the technical log is still there under *Activity log*. |
| 🔦 | **Spotlight highlight** | The page is dimmed around a pulsing ring; hover the target and the dim fades so menus stay readable. Press Esc or the × to dismiss. |
| 📂 | **Dropdown awareness** | Hidden menu items are found, opened and highlighted; menus you open yourself are recognised live, and the right option is highlighted instantly. |
| 📞 | **Footer and info answers** | Ask for a phone number, email or address and GuideMe highlights it on the page and puts the actual answer in the instruction. Footer links are searched too. |
| 🪜 | **Multi-step guidance** | Goals that take several clicks across several pages are followed from start to finish, with a final "All done!" card. |
| 📝 | **Forms and page text** | Guides you field by field through forms (labels only, never what you type) and can answer from page text, such as a fee or a deadline. |
| ⚡ | **Response cache** | Repeating the same request on the same page is answered instantly from memory. |
| 🔒 | **Links stay in your tab** | Highlighted links that would open a new tab are kept in the current tab so you never lose your place. |
| 🔁 | **Retries and model fallback** | Automatic retries and switching between two Gemma 4 models when the API misbehaves. |

## 🧰 Tech stack

GuideMe has no build step, no framework and no backend. It is plain web technology running inside Chrome, talking directly to Google's Gemini API.

<div align="center">

<table>
  <tr>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/googlechrome" width="48" height="48" alt="Chrome"><br><b>Chrome</b><br><sub>Extension platform, Manifest V3</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/javascript" width="48" height="48" alt="JavaScript"><br><b>JavaScript</b><br><sub>Vanilla ES6+, no bundler</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/html5" width="48" height="48" alt="HTML5"><br><b>HTML5</b><br><sub>Side panel and options UI</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/css3" width="48" height="48" alt="CSS3"><br><b>CSS3</b><br><sub>Styling, RTL support</sub></td>
  </tr>
  <tr>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/googlegemini" width="48" height="48" alt="Gemma / Gemini"><br><b>Gemma 4</b><br><sub>Open-weight model by Google</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/google" width="48" height="48" alt="Google AI Studio"><br><b>Gemini API</b><br><sub>Hosted inference, free tier key</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/github" width="48" height="48" alt="GitHub"><br><b>GitHub</b><br><sub>Source hosting and releases</sub></td>
    <td align="center" width="140"><img src="https://cdn.simpleicons.org/githubpages" width="48" height="48" alt="GitHub Pages"><br><b>GitHub Pages</b><br><sub>Setup page in <code>docs/</code></sub></td>
  </tr>
</table>

</div>

### What we used, and where

| Layer | Technology | Used for |
|---|---|---|
| Platform | <img src="https://cdn.simpleicons.org/googlechrome" width="16" height="16"> Chrome Extension, **Manifest V3** | Packaging, permissions, service worker |
| UI shell | <img src="https://cdn.simpleicons.org/googlechrome" width="16" height="16"> **Side Panel API** (`chrome.sidePanel`) | The orchestrator UI that stays open while you browse |
| Page access | <img src="https://cdn.simpleicons.org/javascript" width="16" height="16"> **Content script** (`content.js`) | Scanning the DOM and drawing the highlight |
| Overlay | <img src="https://cdn.simpleicons.org/html5" width="16" height="16"> **Shadow DOM** | Spotlight, ring and card that never clash with the host page's CSS |
| State | <img src="https://cdn.simpleicons.org/googlechrome" width="16" height="16"> `chrome.storage.session` / `local` | Session history (session) and API key plus model choice (local) |
| Background | <img src="https://cdn.simpleicons.org/googlechrome" width="16" height="16"> **Service worker** (`background.js`) | Opens the side panel on icon click |
| AI model | <img src="https://cdn.simpleicons.org/googlegemini" width="16" height="16"> **Gemma 4** (`gemma-4-26b-a4b-it`, `gemma-4-31b-it`) | Verifying clicks, choosing the next element, writing instructions |
| AI access | <img src="https://cdn.simpleicons.org/google" width="16" height="16"> **Gemini API** (`generativelanguage.googleapis.com`) | REST calls straight from the browser |
| Ranking | <img src="https://cdn.simpleicons.org/javascript" width="16" height="16"> Local scorer with a synonym map | Trimming the page to the 60 most relevant items before the model call |
| Hosting | <img src="https://cdn.simpleicons.org/githubpages" width="16" height="16"> GitHub Pages | Download and setup guide |
| License | <img src="https://cdn.simpleicons.org/apache" width="16" height="16"> Apache 2.0 | Open source, permissive |

### Third-party services and apps

<p>
  <a href="https://aistudio.google.com/apikey"><img alt="Google AI Studio" src="https://img.shields.io/badge/Google%20AI%20Studio-API%20key-4285F4?logo=google&logoColor=white"></a>
  <a href="https://ai.google.dev/gemma"><img alt="Gemma" src="https://img.shields.io/badge/Gemma%204-open%20weights-8E75B2?logo=googlegemini&logoColor=white"></a>
  <a href="https://ai.google.dev/gemini-api/docs"><img alt="Gemini API" src="https://img.shields.io/badge/Gemini%20API-REST-1A73E8?logo=googlegemini&logoColor=white"></a>
  <a href="https://developer.chrome.com/docs/extensions"><img alt="Chrome Extensions" src="https://img.shields.io/badge/Chrome%20Extensions-MV3-4285F4?logo=googlechrome&logoColor=white"></a>
  <a href="https://github.com/huzaifa282/GuideMe"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-source-181717?logo=github&logoColor=white"></a>
  <a href="https://huzaifa282.github.io/GuideMe/"><img alt="GitHub Pages" src="https://img.shields.io/badge/GitHub%20Pages-setup%20page-222?logo=githubpages&logoColor=white"></a>
</p>

> **No npm packages.** GuideMe ships zero runtime dependencies, so there is nothing to install or audit besides the extension itself.

## 🚀 Install and run

GuideMe is a Chrome extension that you load yourself, so it takes about three minutes and needs **Google Chrome 116 or newer**. (A website cannot install a Chrome extension by itself, because Chrome only allows one-click installs from the Chrome Web Store.) Each person uses their own free Gemini API key.

### Quick start

Open the **[GuideMe setup page](https://huzaifa282.github.io/GuideMe/)** for a download button and the same steps with a copy button for `chrome://extensions`. Or follow the steps here:

1. **Get a free Gemini API key** at <https://aistudio.google.com/apikey>.
2. **Get the code.** Download the ZIP ([`main.zip`](https://github.com/huzaifa282/GuideMe/archive/refs/heads/main.zip)) and unzip it, or clone it:
   ```bash
   git clone https://github.com/huzaifa282/GuideMe.git
   ```
3. Open `chrome://extensions` in Chrome and switch on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json` (`GuideMe-main` if you used the ZIP, `GuideMe` if you cloned).
5. Click the puzzle-piece icon in the Chrome toolbar and **pin GuideMe**.
6. Open **Settings** (the gear in the side panel, or right-click the GuideMe icon → *Options*), paste your API key and press **Save**. You can also choose the model and switch the look-ahead off there.

### Using GuideMe

1. Open the website you need help with (a normal web page, not a `chrome://` page).
2. **Click the GuideMe icon.** The side panel opens and stays open while you click around the page.
3. Type what you want to do (for example *"apply for undergraduate admission"*, or tap an example) and press **Guide me**.
4. GuideMe highlights the next thing to click and shows a short instruction at the edge of the screen.
5. **Click the highlighted item.** GuideMe moves on to the next step by itself, even when the click opens a new page. When the goal is reached you will see an **All done!** card.
6. Press **Stop** at any time to end the session. Press **Esc** or the **×** on the card to hide a highlight.

### For developers

- After editing a file, click the **reload arrow** on GuideMe's card at `chrome://extensions`, then **close and reopen the side panel** (an open panel keeps running the old code).
- Instead of the Options page you can copy `env.example.js` to `env.js` (it is git-ignored), put your key in it and reload the extension. A key saved in Options takes priority.
- The orchestration lives in the side panel: right-click the panel → *Inspect* to see its console. The page script (`content.js`) logs to the page's own DevTools console, and `background.js` only opens the panel.

### Troubleshooting

| What you see | What to do |
|---|---|
| `Add your Gemini API key in Settings first` | Open Settings (gear icon), paste your key from <https://aistudio.google.com/apikey> and Save. |
| `Cannot run on this page` | Chrome blocks extensions on `chrome://` pages and the Chrome Web Store. Open a normal website. |
| `Gemma is busy, trying again...` | The API is slow or returned an error. GuideMe retries and may switch models by itself. |
| A **Retry** button appears | Every retry failed. Press Retry to continue from the same step without starting over. |
| Nothing is highlighted | The page may still be loading, or the content is inside an iframe. Wait a moment and press Start again. |
| The panel seems to ignore a code change | Reload the extension and reopen the side panel. |

## 🗂️ Project structure

```
GuideMe/
├── manifest.json     Extension manifest (MV3), permissions, entry points
├── background.js     Service worker: opens the side panel on icon click
├── sidepanel.html    Side panel UI (goal, status, step timeline, activity log)
├── sidepanel.css     Side panel styles (light and dark)
├── sidepanel.js      Orchestrator: understand -> scan -> rank -> Gemma -> highlight,
│                     plus the look-ahead scout
├── content.js        Page scanner and Shadow DOM highlight overlay
├── options.html      Settings page (API key, model, look-ahead)
├── options.css       Settings page styles
├── options.js        Saves settings to chrome.storage.local
├── icons/            Logo (SVG) and toolbar icons (PNG)
├── env.example.js    Template for a local, git-ignored API key file
├── docs/index.html   GitHub Pages setup and download page
└── LICENSE           Apache 2.0
```

## 🔐 Privacy

- Your API key is stored only in your browser (`chrome.storage.local`, or the local `env.js` file if you use it). It is never committed to the repo.
- GuideMe has **no server** and stores no data anywhere except your own browser.
- To work, each request sends the **page title, URL, your goal, and short texts of buttons, links, link paths, field labels and relevant page text** directly from your browser to Google's Gemini API. What you type into form fields is never sent.
- The look-ahead downloads the next pages the way a link preview would: **without your cookies**, only for links GuideMe is about to show you, and never for log-out, delete or file links. You can turn it off in Settings. Do not use GuideMe on pages that show information you would not want sent there. See Google's Gemini API terms for how Google handles API requests.

## ⚠️ Known limitations

- **Free-tier API.** Responses can be slow, and the free tier sometimes returns HTTP 500 errors. GuideMe retries and switches models, but a bad moment can still end in the Retry button.
- **Complex forms.** Multi-field forms, custom widgets and pages that rebuild themselves constantly may be guided less accurately.
- **Iframe-based apps.** Pages that render inside iframes or canvases (Office Online, Google Docs and similar) cannot be scanned.
- **Look-ahead on logged-in or JavaScript-only pages.** The scout reads pages without your cookies and without running their scripts, so behind a login or on single-page apps it stops and GuideMe asks Gemma when you arrive instead.
- **Restricted pages.** Chrome does not allow extensions on `chrome://` pages and the Chrome Web Store.

## 🛣️ Roadmap

- [x] Look-ahead prefetch: prepare the next page's answer before you click.
- [x] Replies in the language of the goal.
- [ ] Self-hosted or on-device Gemma, so nothing leaves the machine.
- [ ] Screenshot (vision) mode for pages that cannot be read as text.
- [ ] More languages (Punjabi, Sindhi, Pashto).

## 📄 License

Apache License 2.0. See [LICENSE](LICENSE).

---

<div align="center">

Built with ❤️ at **Hacktoberfest Hack Day Faisalabad 2026**

<img alt="Hacktoberfest" src="https://img.shields.io/badge/Hacktoberfest-2026-FF8AE2?logo=hacktoberfest&logoColor=white">

</div>
