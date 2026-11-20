"use client";

// The page a capture key opens: /c#k=<key>&t=<text>. A shortcut on a phone, a
// watch through the phone, or headphones through the phone's assistant opens
// it with what was said; this page checks the vault's key, seals the text here
// and puts it in the inbox. Nothing after # is ever sent to a server: only the
// sealed box and the key's token go out.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parseCaptureFragment, parseCaptureKey } from "@sigil/core";
import { CheckIcon, LockIcon } from "@/components/icons";
import { sendWithKey } from "./captureKeyOps";
import { Notice } from "./ui";

// A shortcut may open the page again with new text in the same tab: follow the address.
const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
type Phase = "ready" | "sending" | "sent";

export function CaptureKeyApp() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const sentFor = useRef<string | null>(null);

  const send = async (body: string, title = "") => {
    if (!key.current) return;
    setPhase("sending");
    setError(null);
    try {
      await sendWithKey(key.current, { title, body });
      setPhase("sent");
      setText("");
      // The text leaves the address bar; the key stays, so the page can be used again.
      window.history.replaceState(null, "", `/c#k=${encodeURIComponent(key.current)}`);
    } catch (err) {
      setError((err as Error).message);
      setPhase("ready");
    }
  };

  const fragment = useMemo(() => {
    if (hash === null) return null;
    const f = parseCaptureFragment(hash);
    try {
      if (!f.key) return { ok: false as const };
      parseCaptureKey(f.key);
      return { ok: true as const, ...f, key: f.key };
    } catch {
      return { ok: false as const };
    }
  }, [hash]);
  const broken = fragment !== null && !fragment.ok;

  useEffect(() => {
    if (!fragment?.ok) return;
    key.current = fragment.key;
    // A shortcut sent text along: seal and send it at once, once for each address.
    if (fragment.text.trim() && sentFor.current !== hash) {
      sentFor.current = hash;
      const t = window.setTimeout(() => void send(fragment.text, fragment.title), 0);
      return () => window.clearTimeout(t);
    }
  }, [fragment, hash]);

  return (
    <div className="capture container">
      <section className="capture-card" aria-labelledby="capture-key-title" data-phase={phase}>
        <p className="eyebrow">Capture key</p>
        <h1 id="capture-key-title" className="page-title capture-title">
          Into your inbox
        </h1>
        <p className="muted capture-lead">
          <LockIcon /> Sealed on this device to your vault&apos;s key, after checking it. This key can only add to your inbox; it reads nothing.
        </p>
        {broken ? <Notice kind="error">This page needs a capture key after #. Make one in your vault, under Devices, and open its link.</Notice> : null}
        {phase === "sent" ? (
          <Notice kind="success">
            Sealed and in your inbox.{" "}
            <button type="button" className="text-button" onClick={() => setPhase("ready")}>
              Capture another
            </button>
          </Notice>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        {!broken && (phase === "ready" || phase === "sending") ? (
          <form
            className="capture-form"
            aria-label="Capture with a key"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <div className="field">
              <label className="field-label" htmlFor="capture-key-text">
                What to keep
              </label>
              <textarea id="capture-key-text" className="textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Where you parked, a name, a thought" />
            </div>
            <button type="submit" className="button button-primary button-block" disabled={phase === "sending" || !text.trim()}>
              <CheckIcon /> {phase === "sending" ? "Sealing" : "Seal and send"}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
