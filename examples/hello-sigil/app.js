// The whole example: ask for access, then list, search and read what the
// person allowed. The app key lives in this tab's session storage only.

import { requestAccess, SigilClient } from "./sigil.js";

const $ = (id) => document.getElementById(id);
const KEY = "hello-sigil-access";
let client = null;

function show(access) {
  client = new SigilClient(access);
  $("signed-out").hidden = true;
  $("signed-in").hidden = false;
  $("who").textContent = `Connected to the vault at ${access.vault}.`;
  void listFolders();
}

async function listFolders() {
  try {
    const folders = await client.folders();
    $("folders").replaceChildren(...folders.map((f) => Object.assign(document.createElement("li"), { textContent: `${f.name} (${f.memories})` })));
    $("status").textContent = "";
  } catch (err) {
    $("status").textContent = err.message;
  }
}

$("connect").addEventListener("click", async () => {
  $("status").textContent = "Waiting for your vault";
  try {
    const access = await requestAccess({ vault: $("vault").value, appName: "Hello Sigil" });
    sessionStorage.setItem(KEY, JSON.stringify(access));
    show(access);
  } catch (err) {
    $("status").textContent = err.message;
  }
});

$("query").addEventListener("input", async (e) => {
  const results = await client.search(e.target.value, { limit: 10 });
  $("results").replaceChildren(
    ...results.map((r) => {
      const li = document.createElement("li");
      const b = Object.assign(document.createElement("button"), { type: "button", className: "quiet", textContent: r.title });
      b.addEventListener("click", async () => {
        const { memories } = await client.read([r.id]);
        $("memory").hidden = false;
        $("memory").textContent = memories[0] ? `${memories[0].title}\n\n${memories[0].body}` : "This memory is no longer shared.";
      });
      li.append(b);
      return li;
    }),
  );
});

$("disconnect").addEventListener("click", () => {
  sessionStorage.removeItem(KEY);
  location.reload();
});

const saved = sessionStorage.getItem(KEY);
if (saved) show(JSON.parse(saved));
