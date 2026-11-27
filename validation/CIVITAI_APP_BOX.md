# Civitai app-box validation

These runs used the native 0.2.0 App Block on Windows on November 24, 2026. Each evidence file carries its own page SHA-256. The candidate adds pickup links, expiry cleanup on tab resume, a focused recipient flow, and lower-memory large saves. A preliminary artifact also passed the duplicate-build and independent ZIP checks. [Preliminary package evidence](evidence/civitai-only/packaged-0.2.0.json)

## Review candidate

The exact candidate page SHA-256 is `6be131c4375476476a7a99273836996ae20fe417be440e5ae36c74e043a7550a`. Chrome passed the three-recipient receipt flow, 24-hour cutoff, expiry after simulated resume, on-device ZIP verification, both domain pickup link paths, chat code fallback, source change detection, and model pinning. [Three-recipient run](evidence/civitai-only/candidate-fanout-chrome.json) · [Expiry](evidence/civitai-only/candidate-expiry-chrome.json) · [Resume](evidence/civitai-only/candidate-expiry-resume-chrome.json) · [Pickup links](evidence/civitai-only/candidate-pickup-links-chrome.json)

At a 390 × 844 desktop browser viewport, the same sandboxed App Block completed handoffs to three recipient profiles with keyboard preparation and saves. The sender and pickup panels fit their iframe width. A separate run used Chrome to send and Firefox in another process to save and verify all three copies. [Narrow viewport run](evidence/civitai-only/candidate-fanout-narrow-chrome.json) · [Chrome to Firefox](evidence/civitai-only/candidate-fanout-chrome-to-firefox.json)

The candidate delivered twenty distinct offers sequentially to twenty clean Chrome profiles across both fixture origins. Each profile saved and verified the same SHA-256. The handoff stayed open through receipt nineteen, ended on receipt twenty, and refused preparation with twenty-one names. The ZIP preparation helper separately bundled 25 original entries and refused a 26th file. [Recipient capacity](evidence/civitai-only/candidate-fanout-20-chrome.json) · [ZIP entry limit](evidence/civitai-only/source-file-count-limit.json)

In a controlled comparison with the preceding app page and the same 256 MiB ZIP, the largest guest private-memory sample fell from 1,626,386,432 bytes with structured clone to 904,527,872 bytes with a transfer list, a 44.4% reduction. The submitted candidate also recovered a refused 100 MiB GLB save by requesting a fresh copy over the existing peer connection and confirming its SHA-256 receipt. [Clone control](evidence/civitai-only/save-bridge-control.json) · [Transfer-list experiment](evidence/civitai-only/save-bridge-transfer-experiment.json) · [Candidate save recovery](evidence/civitai-only/candidate-glb-100mib-retry-chrome.json)

## Where the app box worked

The table includes preliminary browser runs and the original sandbox probe. The candidate-specific Chrome results are above.

| Check | Observed result |
| --- | --- |
| Public Civitai origins | The existing Metadata Studio listing returned HTTP 200 on both domains. Its hosted iframe accepted both domains in its frame-ancestor policy. The SAFE Handoff candidate returned 404 on both catalog endpoints when checked. [Read-only probe](evidence/civitai-only/platform-probe.json) |
| Direct connection in the app frame | Two clean Chrome profiles exchanged 39 synthetic bytes over a host-to-host WebRTC data channel with no configured ICE server. Both frames had an opaque origin and a secure context under `allow-scripts`. The in-frame writable file picker and origin-private file system both returned `SecurityError`. [Sandbox probe](evidence/civitai-only/platform-probe.json) |
| Three pickup receipts | Chrome 158.0.8127.89, Edge 158.0.4370.33, and Playwright Firefox 159.0 saved and independently verified the same 131,097-byte file in three separate profiles. Each run rejected a reply for a different invitation and rejected a same-size wrong disk file. Access remained open after the first two receipts and closed after the third. [Chrome](evidence/civitai-only/civitai-live-chrome.json) · [Edge](evidence/civitai-only/civitai-live-msedge.json) · [Firefox](evidence/civitai-only/civitai-live-firefox.json) |
| Separate browser processes | Chrome sent the same fixture to Firefox in a separate browser process. All three Firefox profiles verified their saves and the sender closed on the third receipt. [Cross-engine evidence](evidence/civitai-only/civitai-live-chrome-to-firefox.json) |
| 24-hour cutoff | Each of the three browsers advanced the sender clock by 86,400,000 milliseconds with the recipient waiting to save. The sender closed the connection, removed the pending save action in the guest, and made zero host save calls. [Chrome](evidence/civitai-only/civitai-live-expiry-chrome.json) · [Edge](evidence/civitai-only/civitai-live-expiry-msedge.json) · [Firefox](evidence/civitai-only/civitai-live-expiry-firefox.json) |
| ZIP built in the browser | The sender selected a workflow JSON, a Unicode-named caption, and an empty text file. Each generated archive unpacked on disk to the three original files, each with its matching SHA-256. The archive itself earned one verified-save receipt. [Chrome](evidence/civitai-only/civitai-live-bundle-chrome.json) · [Edge](evidence/civitai-only/civitai-live-bundle-msedge.json) · [Firefox](evidence/civitai-only/civitai-live-bundle-firefox.json) |
| Windows WebKit | Playwright WebKit 27.2 lacked `RTCPeerConnection` in the synthetic frame. The app displayed its compatibility message and the dependency picker initialized. Actual Safari qualification requires a separate test. [Capability probe](evidence/civitai-only/platform-probe.json) |

The browser tests used actual browsers and saved files on one Windows machine. The two Civitai origins and the host's save handler were simulated. The harness used the pinned SDK file validators and the browser's real download API. No live chat was sent. The longest tested offer and reply were 882 and 880 characters. The app wraps a longer code at 1,800 characters for manual chat exchange. [Host contract test](../test/browser/civitai-live.test.ts) · [Civitai host save reference](https://developer.civitai.com/apps/reference/hooks/storage-and-media.md#hook-useSaveImage)

The final Chrome regression passed seven tests. A malformed code was refused. A guest who closed their tab could use a fresh offer while the handoff was open, and the former reply was refused. Two immediate clicks caused one host save. Modifying the physical source after fingerprinting produced zero saves and receipts. When the host had already received an authorized save before expiry, the disk download finished with the expected digest while further saves and receipts stayed closed. [Regression cases](../test/browser/civitai-live.test.ts)

## Candidate file-size boundary results

The sender and guest ran in separate Chrome processes. The first timer starts when the sender submits the reply. The receipt time includes the disk verifier, the browser's SHA-256 check, and the sampled memory instrumentation. Memory figures are the largest of four process-tree private-byte samples. Short-lived allocations between samples may be higher.

| File at the candidate limit | Received | Verified receipt | Sender / guest sampled memory |
| --- | ---: | ---: | ---: |
| 50 MiB text | 12.116 s | 15.069 s | 369.5 / 643.2 MiB |
| 100 MiB binary GLB | 24.296 s | 28.699 s | 372.3 / 644.7 MiB |
| 256 MiB allowed ZIP | 42.082 s | 49.375 s | 384.6 / 863.4 MiB |

Each source matched the disk copy and earned a receipt. Each format's cap plus one byte was rejected before reading or sending. The GLB and ZIP runs used SDK 0.93.0 validators and transferred buffer ownership to the fixture host. Confirm the limits on Civitai’s live host before treating them as production measurements. [Text evidence](evidence/civitai-only/candidate-text-50mib-chrome.json) · [GLB evidence](evidence/civitai-only/candidate-glb-100mib-chrome.json) · [ZIP evidence](evidence/civitai-only/candidate-zip-256mib-chrome.json)

## Repeat the tests

```powershell
npm run check
npm run build:civitai
node --test test/browser/civitai.test.ts test/browser/civitai-live.test.ts
```

Set `SAFE_CIVITAI_LIVE_BROWSER` to `msedge` or `firefox` for the corresponding browser. Set `SAFE_CIVITAI_LIVE_GUEST_BROWSER=firefox` and select the three-profile test by name for independent Chrome and Firefox processes. Point `PLAYWRIGHT_BROWSERS_PATH` to the existing Playwright runtime if needed. Test browsers and the CLI run on the engineering host. End users enter through the Civitai App Store in their existing browser.

Set `SAFE_CIVITAI_NARROW=1` when running the three-profile case to exercise a 390-pixel viewport. Set `SAFE_CIVITAI_LIVE_CAPACITY=1` to run the twenty-recipient case.

For exact boundary measurements, select the test named **a valid file at the app save size boundary** and set `SAFE_CIVITAI_LIVE_BOUNDARY` to `text`, `glb`, or `zip`. Set `SAFE_CIVITAI_LIVE_MEMORY=1` on Windows with Chromium browsers to record the process-tree snapshots.

## Production acceptance

Civitai approved v0.2.0 on November 26, 2026 at 7:03 p.m. EST. Both public catalogs report the same listing and App Block, with the icon, cover and three screenshots. The hosted 121,182-byte HTML matches the submitted ZIP byte for byte, and its iframe policy allows both Civitai origins. [Approval record](evidence/civitai-only/civitai-review-status.json) · [Live deployment verification](evidence/civitai-only/v0.2.0-live-deployment.json)

The signed-in Chrome tab on Civitai.red showed the published iframe, enabled sender and pickup controls, and the dependency picker. The signed-out run URLs returned HTTP 404 on both domains. The signed-in Civitai.com launch and a live pickup across distinct devices remain unverified. [Production launch observations](evidence/civitai-only/v0.2.0-production-launch.json)

For end-to-end acceptance, exchange synthetic pickup codes between authorized accounts on two devices using both official run routes. Measure direct reachability, validate the actual save bridge and its format limits, and confirm both closure conditions. The sandboxed browser test advances a controlled clock for the 24-hour cutoff. [Civitai review process](https://developer.civitai.com/apps/guide/review-and-deploy.md) · [WebRTC specification](https://www.w3.org/TR/webrtc/)

Civitai CLI 0.1.150 opened the official developer tunnel on November 24, 2026. The tunnel verified its local hop. The remote asset URL returned HTTP 401 without an author browser session. The signed-out developer pages on both Civitai domains returned HTTP 404. [Developer preview entry results](evidence/civitai-only/developer-preview-entry.json)

To recheck deployment from the full release workspace with the submitted ZIP retained, run this read-only command.

```powershell
node --use-system-ca scripts/verify-civitai-live.mjs
```

The command checks both catalog entries, their shared App Block identity and media, the hosted iframe policy, and the served HTML SHA-256 against the exact submitted ZIP. Exit code 2 means publication is incomplete. The authenticated browser handoff is a separate acceptance step.

From the public source checkout, run `npm ci` and `node --use-system-ca scripts/verify-civitai-live.mjs --staged`. That mode checks the recorded digests against the checked-in submission files and uses the checked-in HTML for deployment comparison. An added HTML comment in a disposable copy triggered the digest check before it contacted Civitai.
