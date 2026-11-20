"use client";

// Capture keys under Devices: one key per phone, watch or shortcut, write-only
// into the inbox, with ready-made steps for an Apple shortcut (Siri, a watch
// and headphones through the phone) and for Android's share sheet and HTTP
// shortcut apps.

import { useState } from "react";
import { captureLink } from "@sigil/core";
import { MicIcon, PhoneIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as cap from "../captureKeyOps";
import { errorText, useVault } from "../context";
import { Band, CopyButton, Notice, Quiet } from "../ui";

export function CaptureKeysSection() {
  const { api, vault, data, update } = useVault();
  const [name, setName] = useState("");
  const [plain, setPlain] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<(cap.NewCaptureKey & { token: string; plain: boolean }) | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const reload = async (rows: cap.ServerCaptureKey[]) => {
    const { keys } = await cap.openCaptureKeys(vault, rows);
    update((d) => ({ ...d, captureKeys: keys }));
  };

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("make");
    setError(null);
    try {
      const r = await cap.makeCaptureKey(api, vault, data.boxPublic, name || "Phone shortcut", plain, origin);
      setMade({ ...r.made, token: await cap.tokenFor(r.made.key), plain });
      await reload(r.keys);
      setName("");
      setPlain(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const active = data.captureKeys.filter((k) => !k.revokedAt);

  return (
    <section className="subpanel capture-keys" aria-labelledby="capture-keys-title">
      <h3 id="capture-keys-title" className="settings-heading">
        <MicIcon /> Capture from anywhere <span className="badge">{plural(active.length, "active key")}</span>
      </h3>
      <p className="small muted">
        A key per phone, watch or shortcut, so &quot;remember that I parked on level 3&quot; lands in your inbox. A key can only add to your inbox: it reads nothing, sends at most
        20 a minute and 300 a day, every capture is in your read log, and you revoke each key on its own.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {made ? (
        <div className="subpanel capture-made" data-testid="capture-made">
          <p className="small">
            Copy the key now: it is shown once and kept nowhere else. Put it in the shortcut below. Anything it sends is sealed to your vault&apos;s key on the sending device
            {made.plain ? ", or, for plain text from a shortcut that cannot run code, by Sigil the moment it arrives" : ""}.
          </p>
          <p className="mono small capture-key-text" data-testid="capture-key">
            {made.key}
          </p>
          <div className="row">
            <CopyButton text={made.key} label="Copy the key" />
            <CopyButton text={made.link} label="Copy the capture link" />
          </div>
          <ShortcutSteps keyText={made.key} token={made.token} plain={made.plain} origin={origin} />
          <button type="button" className="button button-small button-ghost" onClick={() => setMade(null)}>
            Done
          </button>
        </div>
      ) : (
        <form className="capture-key-form" onSubmit={make} aria-label="New capture key">
          <Band label="A new key" hint="Name it after where it lives.">
            <div className="field">
              <label className="field-label" htmlFor="capture-key-name">
                Name
              </label>
              <input id="capture-key-name" className="input" value={name} maxLength={80} placeholder="Phone shortcut" onChange={(e) => setName(e.target.value)} />
            </div>
            <label className="checkbox" htmlFor="capture-key-plain">
              <input id="capture-key-plain" type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} />
              <span>
                Also take plain text from a shortcut that cannot run code (a watch)
                <span className="field-hint">Such text travels over HTTPS and Sigil seals it to your vault&apos;s key as it arrives, so Sigil handles it in the clear for that moment. Leave this off when the shortcut can open a link.</span>
              </span>
            </label>
          </Band>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!!busy}>
              <MicIcon /> {busy === "make" ? "Making the key" : "Make a capture key"}
            </button>
          </div>
        </form>
      )}
      {data.captureKeys.length === 0 ? (
        <Quiet>No capture keys yet.</Quiet>
      ) : (
        <ul className="list capture-key-list">
          {data.captureKeys.map((k) => (
            <li key={k.id} className="list-row" data-testid="capture-key-row" data-revoked={k.revokedAt ? "true" : "false"}>
              <div className="list-row-main">
                <p className="list-row-title">
                  <PhoneIcon /> {k.name}
                  {k.plain ? <span className="badge">Plain text allowed</span> : null}
                  {k.revokedAt ? <span className="badge">Revoked</span> : null}
                </p>
                <p className="list-row-meta">
                  Made {formatDateTime(k.createdAt)}. {plural(k.sent, "capture")} sent{k.lastUsedAt ? `, the last ${formatDateTime(k.lastUsedAt)}` : ""}.
                </p>
              </div>
              {!k.revokedAt ? (
                <div className="list-row-actions">
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(k.id);
                      setError(null);
                      try {
                        await reload(await cap.revokeCaptureKey(api, k.id));
                      } catch (err) {
                        setError(errorText(err));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === k.id ? "Revoking" : "Revoke"}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Ready-made steps for an Apple shortcut and for Android. */
function ShortcutSteps({ keyText, token, plain, origin }: { keyText: string; token: string; plain: boolean; origin: string }) {
  const link = captureLink(origin, keyText);
  const req = cap.plainRequest(origin, token);
  return (
    <div className="shortcut-steps">
      <details open>
        <summary>iPhone and iPad: an Apple shortcut, for Siri and headphones</summary>
        <ol className="plain-list">
          <li>Open Shortcuts and make a new shortcut. Name it as you will say it, for example &quot;Remember&quot;.</li>
          <li>Add Dictate Text (or Ask for Input, for typing), then URL Encode on its result.</li>
          <li>
            Add URL with this text, then put the URL Encoded Text at the very end, after <span className="mono">&amp;t=</span>:
            <span className="mono small shortcut-url">{`${link}&t=`}</span>
          </li>
          <li>Add Open URLs. The page seals what you said on the phone and puts it in your inbox.</li>
          <li>Say &quot;Hey Siri, Remember&quot;, then &quot;that I parked on level 3&quot;. With headphones, Siri runs it on the phone the same way.</li>
        </ol>
      </details>
      <details>
        <summary>Apple Watch: a shortcut that sends text</summary>
        {plain ? (
          <ol className="plain-list">
            <li>On the iPhone, make a shortcut with Dictate Text, then Get Contents of URL.</li>
            <li>
              URL <span className="mono small">{req.url}</span>, method POST, header Authorization <span className="mono small">{req.headers.authorization}</span>, request body JSON with a field
              text set to the Dictated Text.
            </li>
            <li>Turn on Show on Apple Watch. The text goes over HTTPS and is sealed to your vault&apos;s key the moment it reaches Sigil.</li>
          </ol>
        ) : (
          <p className="small">A watch cannot open the capture page. Make a key with plain text allowed for it, and use the steps shown then.</p>
        )}
      </details>
      <details>
        <summary>Android: the share sheet, or an HTTP shortcut app</summary>
        <ol className="plain-list">
          <li>Install Sigil to the home screen from the browser menu: it then appears in the share sheet, so text, links and photos go to your inbox, sealed on the phone.</li>
          <li>
            Or, in an app that opens links from a home screen button or from the assistant, open <span className="mono small shortcut-url">{`${link}&t=`}</span> with the text at the end.
          </li>
          {plain ? (
            <li>
              Or, in an HTTP shortcut app, send a POST to <span className="mono small">{req.url}</span> with the header Authorization <span className="mono small">{req.headers.authorization}</span> and the body{" "}
              <span className="mono small">{req.body}</span>.
            </li>
          ) : null}
        </ol>
      </details>
    </div>
  );
}
