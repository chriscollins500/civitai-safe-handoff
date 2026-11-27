# Compatibility

## Files

| Format | Maximum |
| --- | ---: |
| Civitai-allowlisted ZIP | 256 MiB |
| Binary GLB or FBX | 100 MiB |
| JSON, TXT, PNG, JPEG, WebP | 50 MiB |

ZIP entries must satisfy Civitai's ZIP validator. SAFE Handoff can bundle up to 25 selected files. CSV is handled as a supported ZIP member. For Civitai model weights, use the app's dependency pins to point collaborators to the original catalog entries.

## Connection and browsers

Both tabs must stay open and the browsers need a direct route to each other. The App Block uses host-only WebRTC candidates. A shared network works best. Some VPNs, networks, and browser privacy settings prevent a direct connection.

Chrome, Edge, and Firefox were tested on Windows using real browsers in an opaque sandbox fixture for the Civitai host. Both live catalogs serve the same tested app page. The file-size measurements use the fixture. Live cross-device and Safari qualification remain pending.

For a stopped pickup, create a fresh offer while the sender's handoff remains open. For a refused large save, try the app's **Get a fresh copy** action while the original connection is still up.

[App-box test evidence](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/CIVITAI_APP_BOX.md) · [Civitai save bridge](https://developer.civitai.com/apps/reference/hooks/storage-and-media.md#hook-useSaveImage)
