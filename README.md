# GuideMe — Show me where to click

**An open-source Chrome extension that guides anyone through any website step by step, in English or Urdu, powered by Google's open-weight Gemma 4.**

## 1. The problem

Students, parents and first-time users get lost on university and government portals. Menus hide what you need, the right link sits in the footer, and one wrong click sends you back to the start. A good example is applying for undergraduate admission on the UAF portal: the steps exist, but finding them is the hard part.

AI agents solve this by doing the task *for* you. GuideMe does the opposite: it **teaches you to do it yourself**. It points at the right button, tells you in a sentence what to do and why, and waits for you to click.

## 2. Demo

> 🎬 **Demo GIF / video: coming soon.**
>
> <!-- TODO: replace this block with a GIF or a video link, e.g. [![Demo](demo.gif)](https://...) -->

## 3. How it works

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
   |    - writes a short instruction                          |
   |    - prefetches the best item of each relevant dropdown  |
   +--------------------------+-------------------------------+
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
        page changes  -->  rescan  -->  back to step 3
        (up to 8 steps, with the history of what you did)
```

- **Scanner.** The content script lists visible buttons, links, inputs and selects across the *whole* page (not just the viewport), tags each with a zone (header, main, footer, dialog), and also collects non-clickable info such as phone numbers, emails and addresses. Links inside hover menus are included, together with the menu that opens them. If a modal is open, only the modal is sent.
- **Ranker.** To keep requests small and fast, items are scored locally against the goal (word overlap plus a small synonym map, for example *contact* → phone, email, contact us; *apply* → admission, application, register). The top 60 go to the model, and everything currently in view is always included.
- **Navigator.** One Gemma 4 call does two jobs: it judges whether your last click moved you toward the goal and chooses the next element. It also pre-picks the best item inside each relevant dropdown, so when you hover a menu the answer is already there.
- **Highlight.** A Shadow DOM overlay dims the page, rings the target, numbers the step and shows the instruction at the edge of the screen. Hidden dropdown items are opened for you, or the menu trigger is highlighted with "Hover X, then click Y".
- **Loop across pages.** The side panel keeps the goal, step number and history in `chrome.storage.session`. After your click it waits for the next page, rescans, and asks the Navigator again. The session ends when the goal is done, after 8 steps, or when you press **Stop**.
- **Resilience.** Failed calls (HTTP 5xx, network errors) are retried after 1 s, 3 s and 6 s. After two failures on one model GuideMe automatically switches between `gemma-4-26b-a4b-it` and `gemma-4-31b-it` for the rest of the session. While it retries you see "Still trying..."; only when everything fails does a **Retry** button appear, which resumes from the current step.

## 4. Features

- **Roman Urdu, Urdu and English goals.** Type what you want in the language you think in. The instruction card supports right-to-left text.
- **Spotlight highlight.** The page is dimmed around a pulsing ring; hover the target and the dim fades so menus stay readable. Press Esc or the × to dismiss.
- **Dropdown awareness.** Hidden menu items are found, opened and highlighted; menus you open yourself are recognised live, and the right option is highlighted instantly.
- **Footer and info answers.** Ask for a phone number, email or address and GuideMe highlights it on the page and puts the actual answer in the instruction. Footer links are searched too.
- **Multi-step guidance.** Goals that take several clicks across several pages are followed from start to finish, with a final "All done!" card.
- **Response cache.** Repeating the same request on the same page is answered instantly from memory.
- **Links stay in your tab.** Highlighted links that would open a new tab are kept in the current tab so you never lose your place.

## 5. Install and run

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
6. Open the extension's **Options** page (right-click the GuideMe icon → *Options*, or use the *Options* link in the side panel), paste your API key and press **Save**. You can also choose the model there.

### Using GuideMe

1. Open the website you need help with (a normal web page, not a `chrome://` page).
2. **Click the GuideMe icon.** The side panel opens and stays open while you click around the page.
3. Type what you want to do (for example *"apply for undergraduate admission"*) and press **Start**.
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
| `Add your API key in Options` | Open Options, paste your key from <https://aistudio.google.com/apikey> and Save. |
| `Cannot run on this page` | Chrome blocks extensions on `chrome://` pages and the Chrome Web Store. Open a normal website. |
| `Still trying...` | The API is slow or returned an error. GuideMe retries and may switch models by itself. |
| A **Retry** button appears | Every retry failed. Press Retry to continue from the same step without starting over. |
| Nothing is highlighted | The page may still be loading, or the content is inside an iframe. Wait a moment and press Start again. |
| The panel seems to ignore a code change | Reload the extension and reopen the side panel. |

## 6. Privacy

- Your API key is stored only in your browser (`chrome.storage.local`, or the local `env.js` file if you use it). It is never committed to the repo.
- GuideMe has **no server** and stores no data anywhere except your own browser.
- To work, each request sends the **page title, URL, your goal, and short texts of buttons, links and info snippets** directly from your browser to Google's Gemini API. Do not use GuideMe on pages that show information you would not want sent there. See Google's Gemini API terms for how Google handles API requests.

## 7. Known limitations

- **Free-tier API.** Responses can be slow, and the free tier sometimes returns HTTP 500 errors. GuideMe retries and switches models, but a bad moment can still end in the Retry button.
- **Complex forms.** Multi-field forms, custom widgets and pages that rebuild themselves constantly may be guided less accurately.
- **Iframe-based apps.** Pages that render inside iframes or canvases (Office Online, Google Docs and similar) cannot be scanned.
- **Non-English goals.** Gemma understands Urdu and Roman Urdu, but the local ranker's synonym map is English-only, so ranking helps less for those goals, and nothing yet forces replies in Urdu.
- **Restricted pages.** Chrome does not allow extensions on `chrome://` pages and the Chrome Web Store.

## 8. Roadmap

- Look-ahead prefetch: prepare the next page's answer before you click.
- Self-hosted or on-device Gemma, so nothing leaves the machine.
- Screenshot (vision) mode for pages that cannot be read as text.
- More languages, with replies written in the language of the goal.

## 9. License

Apache License 2.0. See [LICENSE](LICENSE).

Built at **Hacktoberfest Hack Day Faisalabad 2026**.
