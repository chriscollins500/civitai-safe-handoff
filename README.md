# Civitai SAFE Handoff

Browser-only creator file sharing inside Civitai. Send a supported file to up to 20 recipients and see a separate receipt each time someone verifies the file they saved. The app clears temporary pickup data at 24 hours or the final verified save, whichever comes first.

Sign in on your preferred domain and open SAFE Handoff if your account has Apps beta access. The [review kit](https://chriscollins500.github.io/civitai-safe-handoff/review/#live-deployment) names the last verified release and matches the hosted HTML to the submitted build on both catalogs.

[Open on Civitai.com](https://civitai.com/apps/run/civitai-safe-handoff) · [Open on Civitai.red](https://civitai.red/apps/run/civitai-safe-handoff) · [Project website](https://chriscollins500.github.io/civitai-safe-handoff/)

[User guide](https://chriscollins500.github.io/civitai-safe-handoff/guide/) · [Wiki](https://github.com/chriscollins500/civitai-safe-handoff/wiki) · [App screenshots](https://chriscollins500.github.io/civitai-safe-handoff/review/#screenshots) · [Support](https://github.com/chriscollins500/civitai-safe-handoff/issues)

## v0.4.0 release

This release includes drop-off requests, ZIP previews, individual revocation, combined verified receipts, and resume for interrupted live transfers. The [v0.4.0 review packet](submission/REVIEW-v0.4.0.md) describes the tested App Block and the browser fixture.

## How it works

1. Prepare one file or a ZIP. Enter one recipient label per line.
2. Create a separate pickup offer for each person and exchange the offer and reply in private Civitai chat.
3. Each recipient saves and selects the completed download. The sender sees a receipt after the SHA-256 matches.
4. Keep the sender tab open until everyone is done. Both browsers need a direct connection. Anyone using Civitai.com or Civitai.red enters through the native App Block.

GitHub Pages serves the project docs. The App Block transfers files between active browsers with no separate transfer service. A suspended tab clears expired pickup data as soon as it runs again. Saved files remain on the recipient’s device.

## Build and verify

Developers use Node.js 26.13 or newer and Civitai CLI 0.1.150.

```sh
npm ci
npm run check
npm test
npm run build:civitai
civitai app validate dist/civitai-app
```

Compare the built index and manifest with the [v0.4.0 submission](submission/v0.4.0/). Run the browser tests with Chrome installed on the engineering host. Users need only their existing browser.

```sh
npm run test:browser
npm run test:site
node --use-system-ca scripts/verify-civitai-live.mjs --staged --version 0.4.0
```

[v0.4.0 browser fixture evidence](validation/v0.4.0.md) · [Live deployment evidence](docs/evidence/current-release.json) · [Report a security concern](SECURITY.md)
