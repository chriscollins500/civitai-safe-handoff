# Review and verification

The v0.2.0 candidate uses the on-site `civitai-safe-handoff` App Block with an iframe sandbox of `allow-scripts` and an empty scope list. The native resource, save, route, and share hooks handle the Civitai integration. Direct peer traffic contains the file.

[Project site](https://chriscollins500.github.io/civitai-safe-handoff/) · [Review kit and screenshots](https://chriscollins500.github.io/civitai-safe-handoff/review/) · [Source](https://github.com/chriscollins500/civitai-safe-handoff)

## Run a reviewer handoff

1. Use two authenticated browser sessions with a reachable direct network path. Open the candidate on Civitai.com and Civitai.red.
2. Send a small JSON file to a reviewer. Exchange the pickup offer and reply through private Civitai chat. Try a link and a plain offer code.
3. In the recipient tab, save the file and select the completed download. Compare its SHA-256 with the sender's original. A different file of the same size should fail verification.
4. Repeat with three recipients. The sender should see a separate receipt for each and see the handoff close immediately after the third. The packaged-browser test uses a synthetic clock to exercise the 24-hour cutoff separately.
5. Use the exact build fingerprints in the repository to match the opened candidate.

The gallery uses synthetic recipients and a synthetic workflow. It captures the actual bundled page under a fixture for the Civitai host.

[App-box evidence and repeatable commands](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/CIVITAI_APP_BOX.md)
