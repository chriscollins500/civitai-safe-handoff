# Review and verification

The review kit identifies the last verified deployment. The deployment record names both Civitai catalogs, the matching App Block, the SHA-256 of the served HTML, and the reviewed ZIP. The manifest uses an `allow-scripts` iframe sandbox and requests zero account scopes.

[Project site](https://chriscollins500.github.io/civitai-safe-handoff/) · [Verified deployment and test screenshots](https://chriscollins500.github.io/civitai-safe-handoff/review/)

## Run a reviewer handoff

1. Use two authenticated browser sessions on separate devices with a reachable direct network path. Open the release on Civitai.com and Civitai.red.
2. Send a small JSON file to a reviewer. Exchange the pickup offer and reply through private Civitai chat. Try a link and a plain offer code.
3. In the recipient tab, save the file and select the completed download. Compare its SHA-256 with the sender's original. A different file of the same size should fail verification.
4. Repeat with three recipients. The sender should see a separate receipt for each and see the handoff close immediately after the third. The packaged-browser test uses a synthetic clock to exercise the 24-hour cutoff separately.
5. Use the deployment record to match the opened build to the submitted ZIP.

The gallery uses synthetic recipients and a synthetic workflow. It captures the actual bundled page under a fixture for the Civitai host.

[App-box evidence and repeatable commands](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/CIVITAI_APP_BOX.md)

## v0.4.0 fixture checks

Use the v0.4.0 reviewed build to reproduce these checks with synthetic files.

1. Open a drop-off request and verify its optional checklist. Prepare a synthetic ZIP and check that the recipient sees the intended entry names and sizes.
2. Interrupt an active transfer. Keep the recipient tab open and issue a fresh offer for that recipient. Compare the resumed ZIP and the original with SHA-256.
3. Export verified receipts after the first save and again after closure. Compare the records against the actual recipients who verified their files.

The v0.4.0 tests used local Civitai host fixtures in Edge and Firefox. To confirm a real pickup, repeat the signed-in test on Civitai with the sender's tab open and a working direct connection. An offline sender would require the temporary storage requested from Civitai.
