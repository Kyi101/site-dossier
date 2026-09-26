# Privacy policy for Site Dossier

Last updated: September 26, 2026

## What Site Dossier does

Site Dossier creates a local design-reference bundle only after you choose a page and click **Start auto capture** or **Start manual recording**. You choose the output folder and can stop from the page control or popup.

## Information handled

The extension processes the selected page URL, visible tab screenshots and video, the page DOM and computed styles, page-linked CSS and JavaScript text, capture timing/viewport metadata, and any note or tags you enter. Manual video may show your visible interactions with the selected page. These inputs are used only to create your requested local reference bundle.

Page content can include private or sensitive information, such as personal details, messages, form content, or account information visible on or present in the page. Capture only pages you intend to save. Site Dossier does not separately access Chrome's browsing-history database, read browser cookies or saved passwords through browser APIs, request microphone/webcam/geolocation access, or run an independent keystroke tracker.

## Storage and retention

Capture media and page content are processed on your device. Temporary capture metadata is kept in session storage so a suspended service worker can recover the active flow; it is removed after the capture succeeds or fails. The selected folder handle is remembered in local IndexedDB so you can choose the same folder again. Chrome may ask you to grant access again.

Saved files remain in your chosen folder until you delete them yourself. You can change the destination in the popup. Removing the extension clears its browser-stored folder selection; it does not delete files already saved to your computer.

## Sharing and network requests

The extension does not upload captures to a developer-operated server and the developer receives no copy of your captures. It has no account system, analytics, advertising, or data-selling service.

To prepare the HTML reference, your browser may request CSS or JavaScript URLs linked by the selected page. Those requests go to the resource hosts used by that page, not a Site Dossier upload service, and may use the browser's normal network behavior. Resource text is saved as reference content; the extension does not evaluate fetched JavaScript in the live page or extension.

If your chosen folder is synced by OneDrive, Dropbox, or another service, that service may upload the files according to your own account and settings. Site Dossier does not configure or control that sync.

## Limited Use

Site Dossier complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to create the local reference bundle requested by you. It is not sold, used for advertising, used to determine creditworthiness or lending eligibility, or made available for the developer to read.

## Saved HTML

Saved HTML may contain source-site scripts, links, or other page content. It is a reference snapshot, not a guaranteed offline copy. Inspect it in a code editor rather than opening it as a trusted local web app.

## Contact

For questions, contact hlib@kyii.studio or use https://github.com/Kyi101/site-dossier/issues. Do not post private captures in a public issue.
