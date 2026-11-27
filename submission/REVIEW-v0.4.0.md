# Civitai SAFE Handoff v0.4.0 review packet

The v0.4.0 App Block is a local review candidate. The current public Civitai deployment is v0.2.0. Both use a script-only iframe, zero account scopes, and the user's existing browser.

- [Project website](https://chriscollins500.github.io/civitai-safe-handoff/)
- [GitHub Wiki](https://github.com/chriscollins500/civitai-safe-handoff/wiki)
- [Source repository](https://github.com/chriscollins500/civitai-safe-handoff)
- [Staged review gallery](../docs/review/index.html#v040)
- [ZIP preview](../docs/assets/v0.4.0/v0.4.0-archive-preview.png)
- [Interrupted pickup](../docs/assets/v0.4.0/v0.4.0-resume-prompt.png)
- [Combined verified receipts](../docs/assets/v0.4.0/v0.4.0-batch-receipts.png)

## Exact artifact

The [candidate page](v0.4.0/index.html) and [manifest](v0.4.0/block.manifest.json) match the tested build. The screenshots show synthetic inputs in Edge under a Civitai host fixture.

| Artifact | SHA-256 |
| --- | --- |
| 38,371-byte candidate ZIP | `f3e50116612406efcb46ddaf05955c70e46b68613b6db34b10f9a4e4efbb1828` |
| App HTML | `1dab3e3da2347bbd92e609799181ed8ba81ec0ebc2244c458cf25006cc156c3b` |
| Block manifest | `782bcb7a4cc68508c21becf48d4e2ee20b7637981c51f302a62d5c829d314fbe` |

## Reviewer walkthrough

1. Open the candidate through the authorized Civitai host on Civitai.com and Civitai.red in authenticated browsers on separate devices with a direct network path.
2. Prepare a synthetic text file or ZIP. Create one offer per recipient and exchange the offer and reply through private Civitai chat. Confirm the recipient sees the intended file and ZIP entries before saving.
3. Save the file and select the completed download for SHA-256 verification. Check the individual and combined receipt. Finish the last required receipt and verify closure. Run the time-controlled cutoff case separately.
4. Interrupt a transfer while the pickup tab remains open. Issue a fresh offer to the same recipient, resume, and independently compare the completed ZIP to the source. Repeat with a discarded partial, a different recipient offer, and an expired offer.
5. Open a drop-off request and use the optional checklist. Prepare a response, return its pickup link, and complete the verified handoff when both tabs are available.

Files move through a direct WebRTC connection between active browsers. The offline pickup gate requires Civitai-hosted storage with server-enforced payload deletion at expiry or the last verified receipt. [Candidate evidence and build commands](../validation/v0.4.0.md)
