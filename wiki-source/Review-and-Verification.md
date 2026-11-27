# Review and verification

Version 0.2.0 is approved and live. Its hosted HTML matches the submitted ZIP byte for byte, and both Civitai catalogs identify the same `civitai-safe-handoff` App Block. The manifest uses an `allow-scripts` iframe sandbox and requests zero account scopes.

[Project site](https://chriscollins500.github.io/civitai-safe-handoff/) · [Review kit and screenshots](https://chriscollins500.github.io/civitai-safe-handoff/review/) · [Live deployment evidence](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/evidence/civitai-only/v0.2.0-live-deployment.json)

## Run a reviewer handoff

1. Use two authenticated browser sessions on separate devices with a reachable direct network path. Open the release on Civitai.com and Civitai.red.
2. Send a small JSON file to a reviewer. Exchange the pickup offer and reply through private Civitai chat. Try a link and a plain offer code.
3. In the recipient tab, save the file and select the completed download. Compare its SHA-256 with the sender's original. A different file of the same size should fail verification.
4. Repeat with three recipients. The sender should see a separate receipt for each and see the handoff close immediately after the third. The packaged-browser test uses a synthetic clock to exercise the 24-hour cutoff separately.
5. Use the deployment record to match the opened build to the submitted ZIP.

The gallery uses synthetic recipients and a synthetic workflow. It captures the actual bundled page under a fixture for the Civitai host.

[App-box evidence and repeatable commands](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/CIVITAI_APP_BOX.md)
