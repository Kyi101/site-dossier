# Site Dossier

A Chrome extension for saving web design references to a folder you choose. A capture contains a full-page JPEG, a scroll video, a contact sheet when video decoding succeeds, a best-effort HTML snapshot, design tokens, and your note and tags.

Site Dossier runs when you press **Start auto capture** or **Start manual recording**. It saves files locally and has no account, telemetry, or developer-operated server.

## Requirements

- Chrome 116 or newer
- A regular HTTPS page, or a local development page on localhost or 127.0.0.1
- A writable folder on the same computer as Chrome

## Install

1. Download and extract a release ZIP, or clone this repository.
2. Open `chrome://extensions/` and turn on **Developer mode**.
3. Select **Load unpacked** and choose the repository folder containing `manifest.json`.
4. Open a page you want to capture, click the toolbar icon, and select an output folder.

If Chrome runs on Windows, choose a Windows folder in the picker. Chrome blocks the Desktop and Documents root folders; choose or create a folder inside them, such as `Desktop\Site Dossier`. Chrome may not allow a folder inside WSL.

## Capture a page

Use **?** in the popup for a quick guide to capture modes, stopping, saving, and folders.

1. Open the page, click the toolbar icon, and choose a Windows folder. The picker starts in Downloads, then remembers the last chosen location. Browse to a subfolder if you want to save on Desktop.
2. Add an optional note and comma-separated tags.
3. The popup follows your system theme. Leave **Auto capture** selected and click **Start auto capture**. Site Dossier records video and takes screenshot tiles in one scroll pass, then stops by itself at the bottom or after 30 seconds. The camera flashes for each screenshot.
4. For interactive sites, select **Manual recording** instead. Drive the page yourself, then use **Stop** on the camera control or **Stop recording** in the popup. After Stop, the page scrolls once automatically to take screenshots, then returns to your position. Manual recording also stops after 180 seconds.
5. Keep the captured tab active while **Saving capture…** is shown. Auto assembles the JPEG from the tiles already captured; Manual scrolls the final page for its JPEG. The camera control shows a saved or failed result afterward.

The camera control stays visible throughout capture and saving. It appears in the saved JPEG and video; the HTML snapshot excludes it.

Capturing the same URL on the same day adds another viewport folder to its bundle. A different URL on the same host gets a separate numbered bundle. Widths below 768 pixels are labelled mobile.

## Output

```text
selected-folder/
└── example-com-2026-09-25/
    ├── url.txt
    ├── note.md
    ├── tokens.json
    └── desktop/
        ├── page.jpg
        ├── page.html
        ├── scroll.webm
        ├── scroll-sheet.png   # best effort
        └── meta.json
```

The HTML file is a reference snapshot, not a guaranteed offline copy. It may contain page scripts and links to the original site. Inspect it in a code editor rather than opening it as a trusted local web app. Some pages use canvas rendering or custom scrolling, so their JPEG may show only part of the design; the scroll video remains useful.

Captures can include private information visible on the page. Choose the page and destination folder carefully. A folder managed by OneDrive, Dropbox, or similar software may sync the files according to your own settings. See [PRIVACY.md](PRIVACY.md). Site Dossier is licensed under the [MIT License](LICENSE).

## Verify and package

Run `node scripts/verify.mjs` for the dependency-free checks. For a local Chrome Web Store candidate ZIP, run `python3 scripts/package.py`. It runs verification and writes `dist/site-dossier-<version>.zip` with only allowlisted extension files. For an actual release, use `python3 scripts/package.py --release`; that also requires a clean committed tree, tracked package files, and the Git-history privacy check across all local branches and tags.

Before a public release, test the ZIP as an unpacked extension in Chrome: run Auto and Manual captures, record manually for more than 30 seconds, switch tabs during saving, capture two URLs on one host, reopen Chrome and re-grant the output folder, and inspect every output file. Chrome Web Store submission has its own listing and privacy requirements.
