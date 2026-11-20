// Runs on chatgpt.com and claude.ai. Adds one small button that offers to save
// the open conversation to the Sigil inbox. Reading happens here; sealing and
// sending happen in the background worker, which holds the app key.

import { parseConversation } from "./capture";
import type { Reply } from "./messages";

const HOST_ID = "sigil-capture";

function mount() {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;right:16px;bottom:88px;z-index:2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; font: 500 13px/1.3 ui-sans-serif, system-ui, sans-serif; }
      button { min-height: 36px; padding: 0 14px; border: 1px solid rgba(255,255,255,.42); border-radius: 4px; background: linear-gradient(180deg,#fdfdfd,#d9dbdf 42%,#a9acb2); color: #08080a; font: inherit; cursor: pointer; box-shadow: 0 8px 24px -8px rgba(0,0,0,.6); }
      button:disabled { opacity: .6; cursor: default; }
      .note { max-width: 260px; padding: 6px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 4px; background: #0b0b0d; color: #f4f4f5; }
      .note:empty { display: none; }
    </style>
    <div class="wrap"><p class="note" role="status"></p><button type="button">Save conversation to Sigil</button></div>`;
  const button = root.querySelector("button")!;
  const note = root.querySelector(".note")!;
  button.addEventListener("click", async () => {
    const conversation = parseConversation(document, location.href);
    if (!conversation || conversation.turns.length === 0) {
      note.textContent = "No conversation found on this page yet.";
      return;
    }
    button.disabled = true;
    note.textContent = "Encrypting for your vault";
    try {
      const reply = (await chrome.runtime.sendMessage({ type: "sigil:capture-conversation", conversation })) as Reply;
      note.textContent = reply.ok ? `${reply.message} Review it in your vault's Inbox.` : reply.error;
    } catch (err) {
      note.textContent = (err as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  document.documentElement.appendChild(host);
}

mount();
