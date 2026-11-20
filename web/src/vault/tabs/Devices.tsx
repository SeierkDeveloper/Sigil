"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deviceFingerprint } from "@sigil/core";
import { CameraIcon, CheckIcon, DeviceIcon, PhoneIcon, QrIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import * as ops from "../ops";
import * as devices from "../deviceOps";
import { forgetDevice, offlineWanted, setOfflineWanted, thisDevice, type DeviceRecord } from "../offline";
import { errorText, useVault } from "../context";
import { Empty, Fingerprint, Notice } from "../ui";

/** The fragment of /vault/pair#<id>.<key>, when the QR code was opened with the phone's own camera. */
function usePairFragment(): string | null {
  const [fragment] = useState(() => {
    if (typeof window === "undefined") return null;
    return window.location.pathname.endsWith("/vault/pair") && window.location.hash.length > 10 ? window.location.hash : null;
  });
  useEffect(() => {
    if (fragment) window.history.replaceState(null, "", "/vault#devices");
  }, [fragment]);
  return fragment;
}

export function DevicesTab() {
  const { api, vault, data, update } = useVault();
  const [names, setNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState<DeviceRecord | null>(null);
  const [offline, setOffline] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fragment = usePairFragment();
  const slots = data.keyslots.filter((s) => s.kind === "device");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<string, string> = {};
      for (const s of data.keyslots.filter((x) => x.kind === "device")) out[s.id] = await devices.deviceName(vault, s);
      const mine = await thisDevice();
      if (!alive) return;
      setNames(out);
      setMe(mine);
      setOffline(offlineWanted());
    })();
    return () => {
      alive = false;
    };
  }, [data.keyslots, vault]);

  const setSlots = (keyslots: ops.KeyslotView[]) => update((d) => ({ ...d, keyslots }));

  return (
    <div className="devices">
      <div className="panel-header">
        <h2 className="panel-title">Devices</h2>
        <p className="small muted">Your phone and every other device, each with its own key slot. Keys reach a new device only sealed to it.</p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      <AddDevice fragment={fragment} onAdded={(keyslots, name) => {
        setSlots(keyslots);
        setMessage(`${name} received your vault. It opens it with its own device key from now on.`);
      }} />

      <h3 className="settings-heading">Paired devices</h3>
      {slots.length === 0 ? (
        <Empty icon={<PhoneIcon />} title="No device added by code yet">
          Open the vault on your phone or another computer, choose Add this device, and scan its code here. Passkeys that sync between your devices work too, without this step.
        </Empty>
      ) : (
        <ul className="list device-list">
          {slots.map((s) => (
            <li key={s.id} className="list-row device-row" data-this={me?.deviceId === s.label ? "true" : "false"}>
              <div className="list-row-main">
                <p className="list-row-title">
                  <PhoneIcon /> {names[s.id] ?? "A device"}
                  {me?.deviceId === s.label ? <span className="badge badge-strong">This device</span> : null}
                </p>
                <p className="list-row-meta">
                  Added {formatDateTime(s.createdAt)}. {s.lastUsedAt ? `Last opened the vault ${formatDateTime(s.lastUsedAt)}.` : "Has not opened the vault yet."}
                </p>
                {revoking === s.id ? (
                  <div className="subpanel">
                    <p className="small">
                      Revoke {names[s.id] ?? "this device"}? Its key slot is deleted and every session it opened ends at once. The next time it reaches Sigil it forgets its device key
                      and its offline copy. What it already showed on its screen cannot be taken back.
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="button button-small button-danger"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          try {
                            setSlots(await devices.revokeDevice(api, s.id));
                            if (me?.deviceId === s.label) await forgetDevice();
                            setRevoking(null);
                          } catch (err) {
                            setError(errorText(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {busy ? "Revoking" : "Revoke"}
                      </button>
                      <button type="button" className="button button-small button-ghost" onClick={() => setRevoking(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              {revoking !== s.id ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small button-ghost" onClick={() => setRevoking(s.id)}>
                    Revoke
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="subpanel device-here" aria-labelledby="device-here-title">
        <h3 id="device-here-title" className="settings-heading">
          <DeviceIcon /> This device
        </h3>
        <label className="checkbox suggest-toggle">
          <input
            type="checkbox"
            checked={offline}
            onChange={async (e) => {
              await setOfflineWanted(e.target.checked);
              setOffline(e.target.checked);
              if (e.target.checked) await ops.loadVault(api, vault, { onRaw: (raw) => void import("../offline").then((m) => m.saveOfflineCopy(raw)) });
            }}
          />
          <span>
            Keep an encrypted copy here for reading offline
            <span className="field-hint">Only ciphertext is stored, with the locked vault key for the way you signed in. Opening it still takes your passkey, wallet, phrase or device key.</span>
          </span>
        </label>
        {me ? (
          <p className="small muted">
            This browser holds a device key for &quot;{me.name}&quot;. It can be used but not read out by the page.{" "}
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                await forgetDevice();
                setMe(null);
                setOffline(false);
              }}
            >
              Forget it here
            </button>
          </p>
        ) : null}
        <p className="small muted">
          <PhoneIcon /> On a phone, add Sigil to your home screen from the browser&apos;s share menu. It then opens like an app, works offline with the copy above, and shows up
          in the share sheet so text, links and photos go straight to your inbox. Or use <Link href="/capture">quick capture</Link>.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the signed-in side of pairing

type Step = { kind: "find" } | { kind: "scanning" } | { kind: "confirm"; target: devices.PairingTarget } | { kind: "sending"; target: devices.PairingTarget };

function AddDevice({ fragment, onAdded }: { fragment: string | null; onAdded(slots: ops.KeyslotView[], name: string): void }) {
  const { api, vault } = useVault();
  const [step, setStep] = useState<Step>({ kind: "find" });
  const [code, setCode] = useState("");
  const [name, setName] = useState("New device");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const follow = useCallback(
    async (frag: string) => {
      setError(null);
      try {
        setStep({ kind: "confirm", target: await devices.findByLink(api, frag) });
      } catch (err) {
        setError(errorText(err));
        setStep({ kind: "find" });
      }
    },
    [api],
  );

  useEffect(() => {
    if (fragment) void follow(fragment);
  }, [fragment, follow]);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStep({ kind: "confirm", target: await devices.findByCode(api, code) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="subpanel pair-panel" aria-labelledby="pair-title" data-step={step.kind}>
      <h3 id="pair-title" className="settings-heading">
        <QrIcon /> Add a device
      </h3>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {step.kind === "find" || step.kind === "scanning" ? (
        <>
          <ol className="mini-steps">
            <li>On the new device, open this site&apos;s vault and choose Add this device. It shows a code.</li>
            <li>Scan it here, or with this phone&apos;s camera app, or type the ten characters below.</li>
          </ol>
          {step.kind === "scanning" ? (
            <Scanner
              onFound={(text) => {
                try {
                  const u = new URL(text);
                  if (!u.pathname.endsWith("/vault/pair")) throw new Error("not a pairing code");
                  void follow(u.hash);
                } catch {
                  setError("That is not a Sigil pairing code.");
                  setStep({ kind: "find" });
                }
              }}
              onClose={() => setStep({ kind: "find" })}
            />
          ) : null}
          <form className="pair-code-form" onSubmit={find} aria-label="Pairing code">
            <div className="field">
              <label className="field-label" htmlFor="pair-code">
                Code on the new device
              </label>
              <input id="pair-code" className="input mono pair-code-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="7KQ2M-9XD4P" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </div>
            <div className="row">
              <button type="submit" className="button button-primary" disabled={busy || code.replace(/[\s-]/g, "").length < 10}>
                {busy ? "Looking" : "Find the device"}
              </button>
              {step.kind === "find" && scannerAvailable() ? (
                <button type="button" className="button" onClick={() => setStep({ kind: "scanning" })}>
                  <CameraIcon /> Scan the code
                </button>
              ) : null}
            </div>
          </form>
        </>
      ) : (
        <div className="pair-confirm" data-testid="pair-confirm">
          <p className="small">
            A new device is waiting with the code <strong className="mono">{step.target.code}</strong>. Check that the new device shows this same fingerprint:
          </p>
          <Fingerprint value={deviceFingerprint(step.target.publicKey)} className="pair-fingerprint" />
          <div className="field">
            <label className="field-label" htmlFor="pair-name">
              Name it
            </label>
            <input id="pair-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <button
              type="button"
              className="button button-primary"
              disabled={step.kind === "sending"}
              onClick={async () => {
                const target = step.target;
                setStep({ kind: "sending", target });
                setError(null);
                try {
                  onAdded(await devices.sendToDevice(api, vault, target, name), name.trim() || "The new device");
                  setStep({ kind: "find" });
                  setCode("");
                } catch (err) {
                  setError(errorText(err));
                  setStep({ kind: "confirm", target });
                }
              }}
            >
              {step.kind === "sending" ? "Sending" : (<><CheckIcon /> It matches: send my vault</>)}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: "find" })}>
              Cancel
            </button>
          </div>
          <p className="small faint">The vault key goes sealed to a key only the new device holds. The server passes on a box it cannot open.</p>
        </div>
      )}
    </section>
  );
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

function scannerAvailable(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

/** Reads a QR code from the camera with the browser's own detector. Nothing leaves the page. */
function Scanner({ onFound, onClose }: { onFound(text: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        const detector = new Ctor({ formats: ["qr_code"] });
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            if (found[0]?.rawValue) {
              onFound(found[0].rawValue);
              return;
            }
          } catch {
            // The frame was not ready; try the next one.
          }
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      } catch {
        setError("The camera could not be opened. Type the code instead, or scan it with your camera app.");
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onFound]);

  return (
    <div className="scanner">
      {error ? <Notice kind="error">{error}</Notice> : <video ref={video} className="scanner-video" muted playsInline aria-label="Camera" />}
      <button type="button" className="button button-small button-ghost" onClick={onClose}>
        Stop scanning
      </button>
    </div>
  );
}
