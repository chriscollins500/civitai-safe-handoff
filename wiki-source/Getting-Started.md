# Getting started

## Send a file

1. Open **Civitai SAFE Handoff** on [Civitai.com](https://civitai.com/apps/run/civitai-safe-handoff) or [Civitai.red](https://civitai.red/apps/run/civitai-safe-handoff). Sign in to check your Apps beta access.
2. Select one file or up to 25 files to bundle into a ZIP. Enter up to 20 recipients, one name per line, and choose **Prepare handoff**.
3. Under each person's name, choose **Create pickup offer**. Use **Copy pickup link** when available and send it in that person's private Civitai chat. Otherwise copy the offer code. If a code has several lines, send each line separately in order.
4. Paste the recipient's reply into their row and choose **Connect recipient**. Keep the sender tab open until you see **Verified save** for everyone who should get a copy.

## Pick up a file

1. Open your offer's link or paste the code into **Pickup offer**. Choose **Create pickup reply** and send your reply to the sender in private Civitai chat.
2. Wait for the sender to connect. After the app verifies the received file, choose **Save file**.
3. Once the download is complete, choose **Verify saved file** and select that file. The sender sees the receipt when the SHA-256 matches. If a large save was interrupted, **Get a fresh copy** can redeliver it over the active connection.

## Request a drop-off

1. Optionally add a checklist of what to send. Choose **Create request link** and paste it into private Civitai chat. Anyone with the link can read its checklist.
2. The collaborator opens the request, selects the files, and chooses **Prepare drop-off**. The app creates a return pickup link when it fits in one chat message. The collaborator sends it back in the same chat.
3. Follow the pickup instructions above. The request works after the originator closes their browser. Both people must keep their tabs open during the actual file transfer.

## Resume a live pickup

If a connection drops while the file arrives, keep the pickup tab open. Ask the sender for a fresh offer for the same recipient. Open the offer in that pickup tab and send the new reply in private Civitai chat. The app continues from the retained byte offset. To start over, choose **Discard partial file** before opening the new offer.

The pickup preview appears after the whole file verifies. Expand the archive entry list to check the ZIP before saving it.

## Pin models

Use **Choose checkpoint** or **Choose LoRAs** to find the exact version of a Civitai resource. Select a file where the version offers a choice. **Save dependency JSON** exports the catalog identifiers and available hashes. Each collaborator opens or downloads the original model through Civitai using their own account access.

[Guide with screenshots](https://chriscollins500.github.io/civitai-safe-handoff/guide/)
