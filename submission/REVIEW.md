# Civitai App Store review packet

**Civitai SAFE Handoff v0.2.0**

- [GitHub Pages site](https://chriscollins500.github.io/civitai-safe-handoff/)
- [GitHub Wiki](https://github.com/chriscollins500/civitai-safe-handoff/wiki)
- [Project source](https://github.com/chriscollins500/civitai-safe-handoff)
- [Screenshot gallery](https://chriscollins500.github.io/civitai-safe-handoff/review/#screenshots)
- [Sender screenshot](assets/sender.png)
- [Pickup screenshot](assets/pickup.png)
- [Receipts screenshot](assets/receipts.png)

This is an on-site script-only App Block for Civitai.com and Civitai.red with zero account scopes. Both browser tabs stay online. Exchange offer and reply in private Civitai chat, send supported files over a direct WebRTC connection, and verify completed downloads against SHA-256. Pickup data clears at 24 hours or the last verified receipt. Model pins use the Civitai resource picker.

To review, open the app in two authenticated Civitai sessions on a network that allows direct connectivity. Prepare a small synthetic JSON file and exchange the offer and reply. In the recipient tab, save the file, then select it for verification. The sender should see a verified receipt and the handoff should close when the last recipient verifies.

The HTML SHA-256 is `6be131c4375476476a7a99273836996ae20fe417be440e5ae36c74e043a7550a`. Screenshots show the exact app page in Chrome with synthetic inputs and a host fixture. See the [candidate evidence](https://github.com/chriscollins500/civitai-safe-handoff/blob/main/validation/CIVITAI_APP_BOX.md).
