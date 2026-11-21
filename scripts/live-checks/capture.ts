// A capture key as the Apple Shortcut uses it: one plain text sent to the inbox.
import { captureToken, parseCaptureKey } from "../../packages/core/src";
import { ask, bad, baseUrl, done, note, ok } from "./lib";

const base = baseUrl(await ask("SIGIL_URL", "Address of the node (https://...)"));
const key = await ask("SIGIL_CAPTURE_KEY", "Capture key (made in the vault under Devices)", { secret: true });
const token = await captureToken(parseCaptureKey(key).secret);
const r = await fetch(`${base}/api/capture/v1/text`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ title: "Go-live check", text: `Sent by the capture check at ${new Date().toISOString()}.` }),
});
r.status === 201 ? ok("sent to the inbox") : bad("capture", `answered ${r.status} ${await r.text()}`);
note("Open the vault, Inbox: the suggestion is there, from the capture key. Reject it.");
done();
