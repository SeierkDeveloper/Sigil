// The options page: pair the extension with a vault by its address and an
// app key, or forget the pairing.

import { chromeStore, pair } from "./pairing";

const store = chromeStore();
const form = document.getElementById("pair") as HTMLFormElement;
const url = document.getElementById("url") as HTMLInputElement;
const key = document.getElementById("key") as HTMLInputElement;
const note = document.getElementById("note")!;
const paired = document.getElementById("paired")!;
const forget = document.getElementById("forget") as HTMLButtonElement;

async function show() {
  const s = await store.get();
  paired.textContent = s ? `Paired with ${s.baseUrl}. Suggestions go to that vault's Inbox.` : "Not paired yet.";
  forget.hidden = !s;
  document.body.dataset.paired = s ? "yes" : "no";
  if (s) url.value = s.baseUrl;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  note.textContent = "Checking the key against your vault";
  try {
    await pair(store, url.value, key.value);
    key.value = "";
    note.textContent = "Paired. The key was checked against your vault's public key.";
  } catch (err) {
    note.textContent = (err as Error).message;
  }
  await show();
});

forget.addEventListener("click", async () => {
  await store.clear();
  note.textContent = "The app key was removed from this browser. Revoke it in your vault too.";
  await show();
});

void show();
