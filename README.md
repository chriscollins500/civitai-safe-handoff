# Civitai SAFE Handoff

Browser-only creator file sharing inside Civitai. Send a supported file to up to 20 recipients and see a separate receipt each time someone verifies the file they saved. The app clears temporary pickup data at 24 hours or the final verified save, whichever comes first.

[Project website](https://chriscollins500.github.io/civitai-safe-handoff/) · [User guide](https://chriscollins500.github.io/civitai-safe-handoff/guide/) · [Wiki](https://github.com/chriscollins500/civitai-safe-handoff/wiki) · [App screenshots](https://chriscollins500.github.io/civitai-safe-handoff/review/#screenshots)

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
npm run build:civitai
civitai app validate dist/civitai-app
```

Compare the built index and manifest with [the review candidate](submission/). Run the browser tests with Chrome installed on the engineering host. Users need only their existing browser.

```sh
npm run test:browser
npm run test:site
```

[Browser and file-size evidence](validation/CIVITAI_APP_BOX.md) · [Review packet](submission/REVIEW.md) · [Report a security concern](SECURITY.md)
