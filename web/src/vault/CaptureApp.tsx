"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CameraIcon, CheckIcon, LockIcon } from "@/components/icons";
import { createApi } from "./api";
import { capture, flushCaptures, pinnedVaultKey, shrinkPhoto } from "./deviceOps";
import { errorText } from "./context";
import { Notice, Spinner } from "./ui";

interface Shared {
  title: string;
  text: string;
  url: string;
  photo: Blob | null;
}

/** What the share sheet left with the service worker, read once and cleared. */
async function takeShared(): Promise<Shared | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("sigil-share", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("items");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const item = await new Promise<Shared | null>((resolve) => {
    const t = db.transaction("items", "readwrite");
    const store = t.objectStore("items");
    const req = store.get("pending");
    req.onsuccess = () => {
      store.delete("pending");
      resolve((req.result as Shared) ?? null);
    };
    req.onerror = () => resolve(null);
  });
  db.close();
  return item;
}

/** Text with a link in it: the link goes in its own field. */
function splitLink(text: string, url: string): { text: string; url: string } {
  if (url) return { text, url };
  const m = /(https?:\/\/\S+)/.exec(text);
  return m ? { text: text.replace(m[1], "").trim(), url: m[1] } : { text, url: "" };
}

type Phase = "checking" | "signed-out" | "ready" | "sending" | "sent";

/**
 * Quick capture: text, a link or a photo, sealed on this device to the vault
 * public key and put in the inbox. The vault does not have to be unlocked; only
 * the session of this device is needed, and offline the capture waits here,
 * already sealed.
 */
export function CaptureApp() {
  const api = useMemo(() => createApi(), []);
  const [phase, setPhase] = useState<Phase>("checking");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [photo, setPhoto] = useState<{ type: "image/jpeg"; data: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [readingPhoto, setReadingPhoto] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const pinned = pinnedVaultKey();
      try {
        const s = await api.get<{ signedIn: boolean }>("session");
        if (!alive) return;
        setPhase(s.signedIn ? "ready" : "signed-out");
        if (s.signedIn) void flushCaptures(api).catch(() => undefined);
      } catch {
        // Offline: a device that has opened the vault before can still seal and queue.
        if (alive) setPhase(pinned ? "ready" : "signed-out");
      }
      if (new URLSearchParams(window.location.search).get("shared")) {
        const shared = await takeShared().catch(() => null);
        if (!alive || !shared) return;
        const parts = splitLink(shared.text, shared.url);
        setTitle(shared.title);
        setText(parts.text);
        setUrl(parts.url);
        if (shared.photo) {
          setReadingPhoto(true);
          shrinkPhoto(shared.photo)
            .then((p) => alive && setPhoto(p))
            .catch(() => alive && setError("That photo could not be read on this device."))
            .finally(() => alive && setReadingPhoto(false));
        }
        window.history.replaceState(null, "", "/capture");
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase("sending");
    setError(null);
    try {
      const r = await capture(api, { title, body: text, url: url || undefined, image: photo ?? undefined });
      setQueued(r.queued);
      setPhase("sent");
      setTitle("");
      setText("");
      setUrl("");
      setPhoto(null);
    } catch (err) {
      setError(errorText(err));
      setPhase("ready");
    }
  };

  return (
    <div className="capture container">
      <section className="capture-card" aria-labelledby="capture-title" data-phase={phase}>
        <p className="eyebrow">Quick capture</p>
        <h1 id="capture-title" className="page-title capture-title">
          Into your inbox
        </h1>
        <p className="muted capture-lead">
          <LockIcon /> Sealed on this device to your vault&apos;s public key. Nothing becomes a memory until you approve it in the inbox.
        </p>
        {phase === "checking" ? <Spinner label="Checking this device" /> : null}
        {phase === "signed-out" ? (
          <Notice>
            Open your vault on this device once first, so it knows your vault&apos;s key. <Link href="/vault">Open the vault</Link>
          </Notice>
        ) : null}
        {phase === "sent" ? (
          <Notice kind="success">
            {queued ? "Sealed and kept on this device. It goes to your inbox as soon as there is a connection." : "Sealed and in your inbox."}{" "}
            <button type="button" className="text-button" onClick={() => setPhase("ready")}>
              Capture another
            </button>
          </Notice>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        {phase === "ready" || phase === "sending" ? (
          <form className="capture-form" onSubmit={submit} aria-label="Quick capture">
            <div className="field">
              <label className="field-label" htmlFor="capture-text">
                What to keep
              </label>
              <textarea id="capture-text" className="textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="A thought, a name, where you parked" autoFocus />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="capture-title-input">
                Title <span className="faint">(optional)</span>
              </label>
              <input id="capture-title-input" className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="capture-url">
                Link <span className="faint">(optional)</span>
              </label>
              <input id="capture-url" className="input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </div>
            <div className="capture-photo">
              {photo ? (
                <figure className="memory-photo">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a photo decrypted on this device, as a data: address */}
                  <img src={`data:${photo.type};base64,${photo.data}`} alt="The photo to capture" />
                  <button type="button" className="text-button small" onClick={() => setPhoto(null)}>
                    Remove the photo
                  </button>
                </figure>
              ) : (
                <label className="button capture-photo-button" htmlFor="capture-photo">
                  <CameraIcon /> {readingPhoto ? "Reading the photo" : "Add a photo"}
                </label>
              )}
              <input
                id="capture-photo"
                className="visually-hidden"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setReadingPhoto(true);
                  shrinkPhoto(f)
                    .then(setPhoto)
                    .catch(() => setError("That photo could not be read on this device."))
                    .finally(() => setReadingPhoto(false));
                }}
              />
              <p className="small faint">Photos are made smaller on this device, then sealed with the text.</p>
            </div>
            <button type="submit" className="button button-primary button-block" disabled={phase === "sending" || readingPhoto || (!text.trim() && !title.trim() && !url.trim() && !photo)}>
              <CheckIcon /> {phase === "sending" ? "Sealing" : "Seal and send"}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
