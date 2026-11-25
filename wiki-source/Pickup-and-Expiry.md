# Pickup and expiry

| Event | What happens |
| --- | --- |
| A recipient opens a link or receives bytes | The pickup stays open and the sender still needs their receipt. |
| A recipient saves and selects a matching disk copy | The sender records their label and verification time. |
| The final required recipient verifies | The handoff closes and releases the temporary file immediately. |
| 24 hours after the handoff was prepared | The app deletes its temporary pickup data, clears the offers, closes the peers, and blocks new saves and receipts. A suspended tab runs its cleanup as soon as it resumes. |
| The sender closes the handoff or the sender tab | The live handoff ends early. |

A download that the browser already started can finish. Saved files, the original file, and chat history remain in the places their owners control. The sender's receipt labels and times remain visible while the sender keeps the closed handoff on screen.

Share each offer only in the intended recipient's private Civitai chat. The offer is a short-lived capability. Recipient labels help you match the reply to the person and organize receipts. The app validates the reply against its specific offer and checks the file hash separately.

Files travel through a WebRTC data channel. The app holds bytes in memory for the live handoff and uses the Civitai host to start the local browser download. It requests zero account scopes and uses no file storage service.
