// The extension's background worker: the right-click menu, and the only part
// that holds the app key and talks to the vault. Pages and the popup ask it to
// save something; it checks the request, seals the suggestion and sends it.

import { conversationDrafts, extractPage, pageDraft, selectionDraft, siteOf } from "./capture";
import { parseMessage, type Reply } from "./messages";
import { chromeStore, send } from "./pairing";

const store = chromeStore();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "sigil-selection", title: "Save selection to Sigil", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "sigil-page", title: "Save this page to Sigil", contexts: ["page"] });
  });
});

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

async function savePage(tabId: number): Promise<Reply> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
  if (!result?.result) return { ok: false, error: "This page could not be read." };
  await send(store, [pageDraft(result.result)]);
  return { ok: true, sent: 1, message: "Sent to your Sigil inbox." };
}

async function saveSelection(tabId: number): Promise<Reply> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ text: String(window.getSelection() ?? ""), title: document.title, url: location.href }),
  });
  const r = result?.result;
  if (!r || !r.text.trim()) return { ok: false, error: "Select some text on the page first." };
  await send(store, [selectionDraft(r.text, r)]);
  return { ok: true, sent: 1, message: "Sent to your Sigil inbox." };
}

async function notify(tabId: number | undefined, reply: Reply) {
  await chrome.action.setBadgeText({ text: reply.ok ? "1" : "!", ...(tabId === undefined ? {} : { tabId }) });
  setTimeout(() => void chrome.action.setBadgeText({ text: "", ...(tabId === undefined ? {} : { tabId }) }), 4000);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    let reply: Reply;
    try {
      if (info.menuItemId === "sigil-selection" && info.selectionText && tab?.url) {
        await send(store, [selectionDraft(info.selectionText, { title: tab.title ?? "", url: tab.url })]);
        reply = { ok: true, sent: 1, message: "Sent to your Sigil inbox." };
      } else if (info.menuItemId === "sigil-page" && tab?.id !== undefined) {
        reply = await savePage(tab.id);
      } else return;
    } catch (err) {
      reply = { ok: false, error: (err as Error).message };
    }
    await notify(tab?.id, reply);
  })();
});

chrome.runtime.onMessage.addListener((raw, sender, respond: (r: Reply) => void) => {
  // Only this extension's own parts may ask; never a web page.
  if (sender.id !== chrome.runtime.id) return false;
  const msg = parseMessage(raw);
  if (!msg) {
    respond({ ok: false, error: "That request was not understood." });
    return false;
  }
  void (async () => {
    try {
      if (msg.type === "sigil:capture-conversation") {
        // The conversation must come from a page on the site it claims.
        if (!sender.tab?.url || siteOf(sender.tab.url) !== msg.conversation.site) throw new Error("This conversation did not come from its own site.");
        const drafts = conversationDrafts(msg.conversation);
        const sent = await send(store, drafts);
        respond({ ok: true, sent, message: `Sent ${plural(sent, "suggestion", "suggestions")} to your Sigil inbox.` });
      } else if (msg.type === "sigil:save-page") {
        respond(await savePage(msg.tabId));
      } else if (msg.type === "sigil:save-selection") {
        respond(await saveSelection(msg.tabId));
      } else {
        const s = await store.get();
        respond(s ? { ok: true, sent: 0, message: `Paired with ${s.baseUrl}.` } : { ok: false, error: "Not paired yet." });
      }
    } catch (err) {
      respond({ ok: false, error: (err as Error).message });
    }
  })();
  return true;
});
