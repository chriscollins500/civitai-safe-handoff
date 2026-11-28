# Pages and release evidence review

Checked November 28, 2026. The public SAFE Handoff site matched all 15 served files from `95daf1804278734042c796013865591df7601599`. The draft builds directly from `docs/` and has 17 public files. The SHA-256 of the sorted draft file manifest is `ae8705f4c85fdfac04cccad7595c239c493f4aa7c7e6c8dbcaf278b89453ffed`.

## Reader journeys

The comparison served the exact published SAFE Handoff pages and the draft at `/civitai-safe-handoff/` in Chrome 158.0.8127.89. It also exercised the [portfolio pilot](https://chriscollins500.github.io/) at `7a4ee57e39ba50885ce54d4c51e8a9caff71a70f` as a reference for above-the-fold navigation and the skip link. The independent comparison covered 14 page and viewport pairs. The regular project-path test covered the home, guide, limits, review kit and 404 at 320, 390, 768, 1024 and 1440 pixels in Chrome and Playwright's managed Chromium 159.0.8154.6.

| Measure | Published SAFE Handoff | Draft |
| --- | --- | --- |
| Direct Civitai app links visible at 390 and 1440 pixels | 0 | 2, both in the first 820 pixels |
| Pickup states explained in the guide | 0 explicit status labels | 3 labels from the app |
| Version labeled live in the review kit | v0.2.0 | v0.4.0 with dated, pinned evidence |
| Hero image returned on a cold home load | 1,783,503 bytes | 1,177,156 bytes |

At both desktop and mobile widths the app link was one Tab after using the skip link. Keyboard navigation reached the pickup section and live deployment record. It could also open the historical screenshot group and complete and reset the synthetic three-person receipt demo. The checked routes had no horizontal overflow, JavaScript errors or third-party page requests. The home has a receipt explanation with JavaScript disabled.

## Asset and evidence choices

The existing 1672 × 941 cover set the fixed pixel reference. Optimized PNG reduced the file by 15.67%. Maximum-quality AVIF saved 45.46% and changed RGB values by up to 2. Lossless WebP saved 606,347 bytes, or 34.0%, with identical decoded pixels. The original PNG remains the fallback. The browser selected the lossless asset at both paired widths.

A trial request from the Pages origin for both catalogs and the hosted app was CORS-readable. It would retrieve 147,889 uncompressed response bytes for every reader who ran the check. The draft uses a small checked-in deployment record and keeps the HTTP comparisons in the maintainer verification command. The offline browser test previously passed with the stale v0.2.0 label. The updated release check rejected stale markup and a changed hosted digest. The online check rejected the historical release and a pin to a commit that lacked the claimed submission. The Pages verifier accepted all 15 published files and rejected a fixture with one altered file. Workflow lint passed the valid files and rejected a mutated runner key.

## App artifact and fixture evidence

A clean install from the npm lockfile rebuilt the submitted manifest and 143,077-byte HTML exactly. The retained 38,371-byte ZIP had SHA-256 `f3e50116612406efcb46ddaf05955c70e46b68613b6db34b10f9a4e4efbb1828`. Both public catalogs, the pinned GitHub submission and the hosted page matched. The HTML SHA-256 was `1dab3e3da2347bbd92e609799181ed8ba81ec0ebc2244c458cf25006cc156c3b`.

The standard app browser suite passed 17 tests in Chrome and managed Chromium. The opt-in twenty-recipient test passed separately in managed Chromium. All twenty verified, the last receipt closed the handoff, and the app refused a twenty-first recipient. Synthetic Civitai fixtures also exercised the 24-hour deadline, an interrupted 8 MiB pickup, drop-off requests and receipt exports. The maximum-size fixture and authenticated two-device Civitai test were outside this review.

CodeQL CLI 2.27.6 analyzed the 15 selected JavaScript and TypeScript files with zero findings in its default suite. The local SARIF SHA-256 is `39c95714265964f65cd0961f8142cdafce958101d0acb06ff2b3b7cf37fbeaf9`. See the repository's current runs for hosted checks and deploy results. [GitHub rollout](GITHUB-ADOPTION.md) · [Actions runs](https://github.com/chriscollins500/civitai-safe-handoff/actions)
