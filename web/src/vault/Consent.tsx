"use client";

import { useEffect, useState } from "react";
import type { OpenFolder } from "@sigil/core";
import { CheckIcon, CloseIcon, FolderIcon, GlobeIcon, LockIcon } from "@/components/icons";
import { plural } from "@/lib/format";
import type { Api } from "./api";
import * as ops from "./ops";
import { errorText } from "./context";
import { Notice, Spinner } from "./ui";

/** What a web app asks for when it opens the Sign in with Sigil window. */
export interface ConsentRequest {
  name: string;
  /** The web app's origin. The answer is posted to this origin and no other. */
  origin: string;
  state: string;
  /** The app also asks to suggest memories to the inbox. */
  suggest: boolean;
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Checks the request in the address. Null when it is missing or malformed. */
export function parseConsentRequest(search: string): ConsentRequest | null {
  const q = new URLSearchParams(search);
  const name = (q.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const state = q.get("state") ?? "";
  let origin = "";
  try {
    const u = new URL(q.get("origin") ?? "");
    if (u.origin === q.get("origin") && (u.protocol === "https:" || (u.protocol === "http:" && isLocal(u.hostname)))) origin = u.origin;
  } catch {
    origin = "";
  }
  if (!name || !origin || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  return { name, origin, state, suggest: q.get("suggest") === "1" };
}

type Answer = { type: "sigil:authorized"; state: string; appKey: string; vault: string } | { type: "sigil:denied"; state: string };

function answer(request: ConsentRequest, message: Answer): boolean {
  const opener = window.opener as Window | null;
  if (!opener) return false;
  // The browser delivers this only if the window that opened us is on the app's origin.
  opener.postMessage(message, request.origin);
  return true;
}

export function Consent({ api, vault, request }: { api: Api; vault: ops.Unlocked; request: ConsentRequest | null }) {
  const [data, setData] = useState<ops.VaultData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggest, setSuggest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "allowed" | "denied">(null);
  const [hasOpener] = useState(() => typeof window !== "undefined" && !!window.opener);

  useEffect(() => {
    let alive = true;
    ops
      .loadVault(api, vault)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, vault]);

  if (!request) {
    return (
      <div className="vault-gate consent" data-state="stopped">
        <ConsentLink />
        <p className="eyebrow">Sign in with Sigil</p>
        <h1 className="vault-gate-title">Sign in with Sigil</h1>
        <Notice kind="error">This request is incomplete. Go back to the app and start again.</Notice>
      </div>
    );
  }
  if (!hasOpener) {
    return (
      <div className="vault-gate consent" data-state="stopped">
        <ConsentLink />
        <p className="eyebrow">Sign in with Sigil</p>
        <h1 className="vault-gate-title">Sign in with Sigil</h1>
        <Notice kind="error">Open this window from the app that asks for access. On its own it cannot hand anything to an app.</Notice>
      </div>
    );
  }
  if (done) {
    return (
      <div className="vault-gate consent" data-state={done} data-testid="consent-done">
        <span className="consent-stamp" aria-hidden="true">
          {done === "allowed" ? <CheckIcon /> : <CloseIcon />}
        </span>
        <h1 className="vault-gate-title">{done === "allowed" ? `${request.name} is connected` : "Nothing was shared"}</h1>
        <p className="muted">
          {done === "allowed" ? "You can change or revoke it at any time in your vault, under Apps. You can close this window." : "You can close this window."}
        </p>
      </div>
    );
  }
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label="Decrypting your vault" />;

  const host = new URL(request.origin).host;
  const chosen = data.folders.filter((f) => selected.has(f.id));
  const toggle = (f: OpenFolder, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(f.id);
    else next.delete(f.id);
    setSelected(next);
  };

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { appKey } = await ops.connectApp(api, vault, { name: `${request.name} (${host})`, kind: "web" }, chosen, {
        canPropose: suggest,
        boxPublic: data.boxPublic,
      });
      if (!answer(request, { type: "sigil:authorized", state: request.state, appKey, vault: window.location.origin })) {
        throw new Error("The app's window was closed. Revoke the new app under Apps and start again from the app.");
      }
      setDone("allowed");
      window.setTimeout(() => window.close(), 400);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const deny = () => {
    answer(request, { type: "sigil:denied", state: request.state });
    setDone("denied");
    window.setTimeout(() => window.close(), 400);
  };

  const counts = new Map<string, number>();
  for (const m of data.memories) counts.set(m.folderId, (counts.get(m.folderId) ?? 0) + 1);

  return (
    <div className="vault-gate consent" data-state="asking" aria-labelledby="consent-title">
      <ConsentLink name={request.name} active={chosen.length > 0 || suggest} />
      <p className="eyebrow">Sign in with Sigil</p>
      <h1 id="consent-title" className="vault-gate-title">
        {request.name} asks to read your vault
      </h1>
      <div className="consent-who">
        <p className="consent-who-label">The answer goes only to</p>
        <p className="consent-origin">
          <GlobeIcon /> <span className="mono">{request.origin}</span>
        </p>
      </div>
      <p className="muted consent-lead">
        Choose what it may read. It gets its own app key that opens only those folders; it decrypts them in your browser on its page, and every read
        goes into your read log. It can never change or delete a memory.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <fieldset className="consent-folders">
        <legend className="field-label">Folders it may read</legend>
        {data.folders.map((f) => (
          <div key={f.id} className="consent-folder" data-on={selected.has(f.id) ? "true" : "false"}>
            <label className="checkbox">
              <input type="checkbox" checked={selected.has(f.id)} onChange={(e) => toggle(f, e.target.checked)} />
              <span>{f.name}</span>
            </label>
            <span className="consent-folder-count" aria-hidden="true">
              <FolderIcon /> {plural(counts.get(f.id) ?? 0, "memory", "memories")}
            </span>
          </div>
        ))}
      </fieldset>
      {request.suggest ? (
        <label className="checkbox suggest-toggle">
          <input type="checkbox" checked={suggest} onChange={(e) => setSuggest(e.target.checked)} />
          <span>
            May suggest memories to your inbox
            <span className="field-hint">Nothing is saved until you approve it.</span>
          </span>
        </label>
      ) : null}
      <div className="consent-terms">
        <ul className="consent-list" data-kind="can" aria-label="What it can do">
          <li>
            <CheckIcon /> {chosen.length ? `Read ${chosen.length === 1 ? chosen[0].name : `${chosen.length} folders`}` : "Read the folders you tick"}
          </li>
          {request.suggest ? (
            <li data-off={suggest ? undefined : "true"}>
              <CheckIcon /> Suggest memories, if you allow it
            </li>
          ) : null}
          <li>
            <CheckIcon /> Show up in your read log, every time
          </li>
        </ul>
        <ul className="consent-list" data-kind="cannot" aria-label="What it can never do">
          <li>
            <CloseIcon /> Change or delete a memory
          </li>
          <li>
            <CloseIcon /> Open a folder you did not tick
          </li>
          <li>
            <CloseIcon /> Keep reading after you revoke it
          </li>
        </ul>
      </div>
      <Notice>Only allow apps you trust: once an app has read a memory, what it does with that text is up to the app.</Notice>
      <div className="form-actions consent-actions">
        <button type="button" className="button button-primary" onClick={() => void allow()} disabled={busy || (chosen.length === 0 && !suggest)}>
          {busy ? "Connecting" : chosen.length ? `Allow reading ${chosen.length === 1 ? chosen[0].name : `${chosen.length} folders`}` : "Allow"}
        </button>
        <button type="button" className="button button-ghost" onClick={deny} disabled={busy}>
          Deny
        </button>
      </div>
      <p className="consent-foot">
        <LockIcon /> Change or revoke it at any time in your vault, under Apps.
      </p>
    </div>
  );
}

/** The app on one side, your vault on the other, and the line between them. */
function ConsentLink({ name, active = false }: { name?: string; active?: boolean }) {
  return (
    <div className="consent-link" data-active={active ? "true" : "false"} aria-hidden="true">
      <span className="consent-party">
        <span className="consent-party-mark">{name ? <span className="consent-initial">{[...name][0]?.toUpperCase()}</span> : <GlobeIcon />}</span>
        <span className="consent-party-name">{name ?? "An app"}</span>
      </span>
      <span className="consent-wire" />
      <span className="consent-party">
        <span className="consent-party-mark consent-party-vault">
          <LockIcon />
        </span>
        <span className="consent-party-name">Your vault</span>
      </span>
    </div>
  );
}
