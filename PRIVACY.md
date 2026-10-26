# Privacy policy for Site Dossier

Last updated: October 26, 2026

## What Site Dossier does

Site Dossier saves local design references after you start a page capture, save an element or rectangular selection, or collect images and screenshots in the side panel. You choose the output folder. You can stop page recording from the page control or popup, and close the selection panel when you are done.

## Information handled

The extension processes the selected page URL, visible tab screenshots and video, the page DOM and computed styles, page-linked CSS and JavaScript text, capture timing/viewport and selection coordinates, and any notes, tags or taste choices you enter. Element selections can include bounded element structure, computed styles and SVG details; rectangle selections save visual evidence without element structure. Manual video may show your visible interactions with the selected page. These inputs are used only to prepare and create your requested local reference bundle.

After you start Manual recording, it continues across page loads and reloads in that same tab, including navigation to other websites, until you stop it or the three-minute limit is reached. It records that tab's video and samples the URLs, titles, page content, styles and viewport images of documents you visit during the recording. Switching tabs does not change which tab is recorded. The final page can be scrolled automatically for its screenshot after recording stops. Closing the recorded tab ends the recording and saves the evidence already available. Pages Chrome does not permit the extension to access end the recording. Manual video and page evidence are held temporarily in the extension's offscreen document while the recording is being prepared for your selected local folder; video is not sent through a server.

Page content can include private or sensitive information, such as personal details, messages, form content, or account information visible on or present in the page. Capture only pages you intend to save. Site Dossier does not separately access Chrome's browsing-history database, read browser cookies or saved passwords through browser APIs, request microphone/webcam/geolocation access, or run an independent keystroke tracker.

## Storage and retention

Capture media and page content are processed on your device. Temporary capture and selection-session metadata is kept in session storage so a suspended service worker can recover the active flow. Page capture metadata is cleared when the flow finishes. Selection-session context remains available between saves until the session ends, including when you close the picker or leave the page. A failed selection save may keep the selection available for retry. The selected folder handle is remembered in local IndexedDB so you can choose the same folder again. Chrome may ask you to grant access again.

As you edit the popup, the extension stores a local form draft associated with that exact page URL. It includes your note, tags, taste checkboxes, capture mode and whether the note section is open. Drafts survive closing the popup and restarting Chrome, and remain available after capture. Other pages use separate drafts. Editing or clearing the fields updates the stored draft. Drafts are stored only in this Chrome profile's extension local storage, not Chrome sync or your output folder.

Saved files remain in your chosen folder until you delete them yourself. You can change the destination in the popup or side panel; both use the same selected folder. Removing the extension clears its browser-stored folder selection and form drafts; it does not delete files already saved to your computer.

The collection side panel stores unsaved image files, image/source URLs, titles, notes, project names, tags and categories locally in the extension’s IndexedDB and local storage. These drafts survive panel closure and Chrome restarts. Successfully saved items are removed from the tray; failed saves remain for retry. Removing a tray item deletes that draft. Uninstalling the extension removes its remaining drafts, but does not delete saved files. Saved reference edits keep older revisions in the selected folder.

## Collection permissions

The side-panel and context-menu permissions provide the collection controls. The extension requests all-sites access during installation or update so you can collect remote images and take screenshots across tabs without repeatedly granting access. Collection runs only when you drag/paste an image, load an image link, or invoke a screenshot or rectangle capture. It does not capture automatically when you open the panel or switch tabs. Site access can be restricted in Chrome’s extension settings, which may prevent collection on those sites.

## Sharing and network requests

The extension does not upload captures to a developer-operated server and the developer receives no copy of your captures. It has no account system, analytics, advertising, or data-selling service.

When you load a remote image, the extension requests that image URL directly from its host, without browser credentials or a referrer. It stores the returned image locally; it does not upload your library. Some hosts block these requests, in which case you can paste an image or take a screenshot.

To prepare the HTML reference, your browser may request CSS or JavaScript URLs linked by the selected page. Those requests go to the resource hosts used by that page, not a Site Dossier upload service, and may use the browser's normal network behavior. Resource text is saved as reference content; the extension does not evaluate fetched JavaScript in the live page or extension.

If your chosen folder is synced by OneDrive, Dropbox, or another service, that service may upload the files according to your own account and settings. Site Dossier does not configure or control that sync.

## Limited Use

Site Dossier complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to prepare and create the local reference bundle requested by you. It is not sold, used for advertising, used to determine creditworthiness or lending eligibility, or made available for the developer to read.

## Saved HTML

Saved HTML may contain source-site scripts, links, or other page content. It is a reference snapshot, not a guaranteed offline copy. Inspect it in a code editor rather than opening it as a trusted local web app.

## Contact

For questions, contact hlib@kyii.studio or use https://github.com/Kyi101/site-dossier/issues. Do not post private captures in a public issue.
