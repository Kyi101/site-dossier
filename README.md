# Site Dossier

A Chrome extension for saving web design references to a folder you choose. Capture a page with readable screenshots and video frames, or pick particular elements and rectangular areas. Your notes and taste choices stay alongside the evidence for you and your agents.

Site Dossier runs when you start a page capture or selection. It saves files locally and has no account, telemetry, or developer-operated server.

## Requirements

- Chrome 116 or newer
- A regular HTTPS page, or a local development page on localhost or 127.0.0.1
- A writable folder on the same computer as Chrome

## Install

1. Download and extract a release ZIP, or clone this repository.
2. Open `chrome://extensions/` and turn on **Developer mode**.
3. Select **Load unpacked** and choose the repository folder containing `manifest.json`.
4. Open a page you want to capture, click the toolbar icon, and select **Choose**. Pick an output folder in the folder dialog, allow access, and continue in the popup.

If Chrome runs on Windows, choose a Windows folder in the picker. Chrome blocks the Desktop and Documents root folders; choose or create a folder inside them, such as `Desktop\Site Dossier`. Chrome may not allow a folder inside WSL.

## Capture a page

Use **?** in the popup for a quick guide to capture modes, stopping, saving, and folders.

1. Open the page and click the toolbar icon. If no folder is selected, choose one directly from the popup and allow access. The picker starts in Downloads, then remembers the last chosen location. Browse to a subfolder if you want to save on Desktop.
2. Optionally select what you like: colors, typography, layout, spacing, imagery, motion, interactions, or small details. Open **Add note & tags** to describe what to reuse or avoid, including a specific part or project when useful. Comma-separated tags organize references, for example scroll-driven, storytelling, or portfolio. Nothing is preselected or required.
3. The popup follows your system theme. Leave **Page → Auto** selected and click **Start auto capture**. Site Dossier records video and takes screenshot tiles in one scroll pass, then stops by itself at the bottom or at the 3-minute limit. The camera flashes for each screenshot.
4. For interactive sites, select **Manual recording** instead. Drive the page yourself, then use **Stop** on the camera control or **Stop recording** in the popup. After Stop, the page scrolls once automatically to take screenshots, then returns to your position. Manual recording also stops after 180 seconds.
5. Keep the captured tab active while **Saving capture…** is shown. Auto assembles the JPEG from the tiles already captured; Manual scrolls the final page for its JPEG, allowing up to 3 minutes for long pages. The camera control shows a saved or failed result afterward and flags time limits or blocked scrolling. Each viewport's `meta.json` records why recording and screenshot scrolling stopped.

The camera control stays visible throughout capture and saving. It appears in the saved JPEG and video; the HTML snapshot excludes it.

Capturing the same URL on the same day adds another viewport folder to its bundle. A different URL on the same host gets a separate numbered bundle. Widths below 768 pixels are labelled mobile.

Each viewport folder includes its own `note.md` and `tokens.json`, so repeated captures preserve their individual notes, tags, taste choices, and styles. The bundle-root copies describe the first capture and remain available for existing workflows. Choices reset when the popup closes, so they do not carry over to another page.

## Capture elements or an area

Choose **Selection** in the extension popup: **Elements / Rectangle** replaces **Auto / Manual** in the same place. Open the picker with the selected tool; it keeps only Save and Close actions. On the page, click to select one element. **Ctrl-click** (Windows/Linux) or **Cmd-click** (Mac) adds or removes items. A plain click replaces the selection. With multiple items, use the menu to choose which item to annotate. Your popup note and taste choices apply to the whole session. After each successful Save, the panel stays open with an empty selection for the next capture. Each save gets its own numbered folder; new item notes start blank.

Drag the small panel by its heading if it covers a detail; its focused heading also supports arrow keys. **Save** writes the crops, a context image, coordinates, and bounded structure/computed styles for picked elements. **Escape** or **Close** exits without saving the current selection. Already saved selections remain on disk. You can also cancel from the popup. A rectangle contains visual evidence only.

When picking an element, browser animations affecting it or its parents/children are held while it stays selected, then resumed after saving, deselecting, or closing. Animations that were already paused stay paused. Script-driven DOM replacement, canvas/video motion and cross-origin animation cannot always be held; Rectangle remains a visual snapshot.

Each selection must fit inside the visible page; the tool flags offscreen or oversized elements instead of silently clipping them. Scroll or zoom out, select a smaller area, or use Page capture for a longer section. Scrolling or resizing clears a drawn rectangle. Desktop browser zoom/display scaling is supported; reset pinch zoom before selecting. The picker is hidden from saved images. Cross-origin iframes and closed shadow roots can be captured visually but their internal structure is unavailable. These files are references, not ready-to-use component exports.

## Use references with an agent

After saving a capture, your selected folder contains `SITE-DOSSIER.md` and a linked reader skill. Give your agent the folder path and ask it to read `SITE-DOSSIER.md` before using the references. For a specific brief, also name the project, websites, or capture folders you want it to use.

The guide explains new and older bundles, separate viewport notes, missing evidence, and the difference between your preferences and automatically sampled styles. Unchecked taste choices mean unspecified, not disliked. Exclusions and project context in your note narrow how a reference should be used.

The skill is a portable Markdown file, not an automatic installation into your agent. It uses relative paths and moves with the folder. Site Dossier creates missing guides during a save and preserves edits. An unchanged entry from an earlier release can be updated to link to the newer versioned reader; old skills remain available. It does not replace your `README.md` or `AGENTS.md`, migrate old captures, or maintain a collection index. If a guide cannot be written, the saved result shows a warning while retaining the capture.

## Output

```text
selected-folder/
├── SITE-DOSSIER.md
├── .site-dossier/
│   └── skills/use-site-dossier-v2/SKILL.md
└── example-com-2026-09-25/
    ├── url.txt
    ├── note.md
    ├── tokens.json
    ├── desktop/
    │   ├── note.md
    │   ├── tokens.json
    │   ├── page.jpg
    │   ├── page-tiles/        # readable JPEGs + index.json
    │   ├── page.html
    │   ├── scroll.webm
    │   ├── video-frames/      # readable JPEGs + timestamp index.json
    │   ├── scroll-sheet.png  # best effort
    │   └── meta.json
    └── selection-desktop/
        ├── note.md
        ├── context.jpg
        ├── selections.json
        ├── selection-01.png
        ├── selection-01.json # element structure/styles; absent for rectangles
        └── meta.json
```

New `note.md` files contain a Markdown note and structured frontmatter: `schema_version`, `tags`, `liked_aspects`, `focus`, `avoid`, and `intended_use`. The older `focus`, `avoid`, and `intended_use` fields remain compatible but are blank in new captures; put that context in the note. `meta.json` records the source title, capture details, and a capture-time copy of the structured preferences. Its schema version is independent of the extension version. If you edit a note afterward, the note takes precedence over that snapshot.

Readable page tiles reuse the existing capture pass and record their CSS positions. Up to 24 tiles are sampled across the page, with an 8 MiB transfer budget; omissions are recorded as normal sampling information, without a save warning. Actual write failures still warn. Video decoding saves up to nine readable stills, including opening/final samples, plus a labeled contact sheet. Readable tiles/frames have a maximum edge of 1280px. Frame timestamps use the media timeline when Chrome can determine it, with the recording clock explicitly labeled as an estimate otherwise. Original video and the stitched page overview remain available. Metadata records dimensions, scale, partial output and warnings.

Design tokens are sampled observations. Variable-font weight ranges are kept separately from individual weights; an unknown font source is not labeled as a system font. Selection structure is bounded to 100 nodes, six child levels, and 256,000 characters per item, with truncation indicated.

The HTML file is a reference snapshot, not a guaranteed offline copy. It may contain page scripts and links to the original site. Inspect it in a code editor rather than opening it as a trusted local web app. Some pages use canvas rendering or custom scrolling, so their JPEG may show only part of the design; the scroll video remains useful.

Captures can include private information visible on the page. Choose the page and destination folder carefully. A folder managed by OneDrive, Dropbox, or similar software may sync the files according to your own settings. See [PRIVACY.md](PRIVACY.md). Site Dossier is licensed under the [MIT License](LICENSE).

## Verify and package

Run `node scripts/verify.mjs` for the dependency-free checks. For a local Chrome Web Store candidate ZIP, run `python3 scripts/package.py`. It runs verification and writes `dist/site-dossier-<version>.zip` with only allowlisted extension files. For an actual release, use `python3 scripts/package.py --release`; that also requires a clean committed tree, tracked package files, and the Git-history privacy check across all local branches and tags.

The privacy check accepts GitHub noreply identities and author metadata from explicitly reviewed public commits, pinned by their full commit hashes in `scripts/public-release-check.mjs`. Other personal commit addresses still require review; these exceptions never exempt file contents or private paths from the audit.

Before a public release, test the ZIP as an unpacked extension in Chrome: run Auto and Manual captures, record manually for more than 30 seconds, switch tabs during saving, capture two URLs on one host, reopen Chrome and re-grant the output folder, and inspect every output file. Chrome Web Store submission has its own listing and privacy requirements.
