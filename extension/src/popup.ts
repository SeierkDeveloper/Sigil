// The toolbar popup: save the selection or the page, and see whether the
// extension is paired with a vault.

import type { Reply } from "./messages";

const status = document.getElementById("status")!;
const result = document.getElementById("result")!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-action]")];

async function tabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function ask(message: object): Promise<Reply> {
  try {
    return (await chrome.runtime.sendMessage(message)) as Reply;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

void ask({ type: "sigil:status" }).then((r) => {
  status.textContent = r.ok ? r.message : "Not paired with a vault yet. Open the options to paste an app key.";
  for (const b of buttons) b.disabled = !r.ok;
});

for (const b of buttons) {
  b.addEventListener("click", async () => {
    const id = await tabId();
    if (id === undefined) return;
    for (const x of buttons) x.disabled = true;
    result.textContent = "Encrypting for your vault";
    const r = await ask({ type: b.dataset.action === "page" ? "sigil:save-page" : "sigil:save-selection", tabId: id });
    result.textContent = r.ok ? `${r.message} Review it in your vault's Inbox.` : r.error;
    for (const x of buttons) x.disabled = false;
  });
}

document.getElementById("options")!.addEventListener("click", () => void chrome.runtime.openOptionsPage());
