// The Model of you tab renders for an empty vault and for a trained one.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyYou } from "@sigil/core";
import { harness, signedUp } from "./helpers";
import * as ops from "../src/vault/ops";
import { Ctx, type VaultCtx } from "../src/vault/context";
import { YouTab } from "../src/vault/tabs/You";
import * as you from "../src/vault/youOps";

function render(ctx: Partial<VaultCtx>): string {
  return renderToStaticMarkup(createElement(Ctx.Provider, { value: ctx as VaultCtx }, createElement(YouTab)));
}

describe("the Model of you tab", () => {
  it("renders empty and trained", async () => {
    const h = harness();
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    for (let i = 1; i <= 5; i++) await ops.createMemory(s.b.api, notes, { title: `Note ${i}`, body: `Body ${i}` });
    const data = await ops.loadVault(s.b.api, s.vault);
    const base = { api: s.b.api, vault: s.vault, update: () => {}, openMemory: () => {}, goTo: () => {} };
    expect(render({ ...base, data: { ...data, you: emptyYou() } })).toContain("Folders it learns from");
    const ids = data.memories.filter((m) => m.folderId === notes.id).map((m) => m.id);
    let state = { ...emptyYou(), folders: [notes.id] };
    for (let i = 0; i < 10; i++) state = you.addChoice(state, ids[i % 2], ids[2 + (i % 3)]);
    state = you.trainOnDevice(data, state);
    const html = render({ ...base, data: { ...data, you: state } });
    expect(html).toContain("of 100");
    expect(html).toContain("Trained on 10 choices");
    expect(html).toContain("Which matters more to you?");
  });
});
