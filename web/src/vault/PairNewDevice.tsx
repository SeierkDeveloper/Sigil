"use client";

import { useEffect, useRef, useState } from "react";
import { deviceFingerprint } from "@sigil/core";
import type { Api } from "./api";
import * as ops from "./ops";
import { finishPairing, pollPairing, startPairing, type PairingSession } from "./deviceOps";
import { errorText } from "./context";
import { Qr } from "./Qr";
import { Fingerprint, Notice, Spinner } from "./ui";

/**
 * The new device's side of pairing: a one-time key, its QR code and short
 * code, and a wait for the sealed vault key. The private half of the one-time
 * key stays in this page's memory and is gone when it closes.
 */
export function PairNewDevice({ api, onUnlocked, onCancel }: { api: Api; onUnlocked(vault: ops.Unlocked): void; onCancel(): void }) {
  const [session, setSession] = useState<PairingSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"waiting" | "opening" | "expired">("waiting");
  const [round, setRound] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    let alive = true;
    done.current = false;
    startPairing(api, window.location.origin)
      .then((s) => alive && setSession(s))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, round]);

  useEffect(() => {
    if (!session) return;
    let timer = 0;
    let alive = true;
    const tick = async () => {
      if (!alive || done.current) return;
      if (Date.now() > Date.parse(session.expiresAt)) {
        setState("expired");
        return;
      }
      try {
        const gift = await pollPairing(api, session);
        if (gift && alive) {
          done.current = true;
          setState("opening");
          onUnlocked(await finishPairing(api, gift));
          return;
        }
      } catch (err) {
        if (!alive) return;
        setError(errorText(err));
        setState("expired");
        return;
      }
      timer = window.setTimeout(tick, 2000);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, session, onUnlocked]);

  return (
    <section className="vault-gate pair-new" aria-labelledby="pair-new-title" data-state={state}>
      <h1 id="pair-new-title" className="vault-gate-title">
        Add this device
      </h1>
      <p className="muted">
        On a device where your vault is open, go to Devices and scan this code, or type the code below. Your vault key comes here sealed to a key that only this page holds.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!session && !error ? <Spinner label="Making a one-time key" /> : null}
      {session && state !== "expired" ? (
        <div className="pair-show">
          <div className="pair-qr">
            <Qr text={session.url} label="Pairing code for this device" />
          </div>
          <div className="pair-details">
            <p className="eyebrow">Code</p>
            <p className="pair-code mono" data-testid="pair-code">
              {session.code}
            </p>
            <p className="eyebrow">Fingerprint to compare</p>
            <Fingerprint value={deviceFingerprint(session.publicKey)} className="pair-fingerprint" />
            <p className="small faint">{state === "opening" ? "Keys received. Opening your vault." : `Waiting for your other device. The code works until ${new Date(session.expiresAt).toLocaleTimeString()}.`}</p>
          </div>
        </div>
      ) : null}
      {state === "expired" ? (
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setState("waiting");
            setError(null);
            setSession(null);
            setRound((r) => r + 1);
          }}
        >
          Make a new code
        </button>
      ) : null}
      <p className="small muted gate-signout">
        <button type="button" className="text-button" onClick={onCancel}>
          Sign in another way
        </button>
      </p>
    </section>
  );
}
