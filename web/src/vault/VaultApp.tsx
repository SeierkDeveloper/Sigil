"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi } from "./api";
import * as ops from "./ops";
import { Gate, type GateMode } from "./Gate";
import { PhraseScreen } from "./PhraseScreen";
import { Dashboard } from "./Dashboard";
import { Consent, type ConsentRequest } from "./Consent";
import { Notice, Spinner } from "./ui";
import { offlineCopy, thisDevice } from "./offline";
import { OfflineVault } from "./OfflineVault";
import { RestoreApp } from "./RestoreApp";

type Phase =
  | { kind: "checking" }
  | { kind: "offline"; copy: boolean }
  | { kind: "offline-copy" }
  | { kind: "gate"; mode: GateMode }
  | { kind: "restore" }
  | { kind: "phrase"; vault: ops.Unlocked; phrase: string }
  | { kind: "open"; vault: ops.Unlocked };

/**
 * The vault page. The vault key lives only in this component's memory: closing
 * or reloading the page locks the vault again. With a consent request it is the
 * Sign in with Sigil window: once open, it asks about one web app instead of
 * showing the dashboard.
 */
export function VaultApp({ consent, restore = false }: { consent?: ConsentRequest | null; restore?: boolean } = {}) {
  const api = useMemo(() => createApi(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  // Signed out on a device that keeps a device key: start on sign-in, where that key is offered.
  const firstPhase = useCallback(async (): Promise<Phase> => {
    // Restoring a bundle, or arriving from another node, starts on its own step, signed in or not.
    if (restore) return { kind: "restore" };
    try {
      const s = await api.get<{ signedIn: boolean }>("session");
      if (s.signedIn) return { kind: "gate", mode: "unlock" };
      return { kind: "gate", mode: (await thisDevice().catch(() => null)) ? "signin" : "create" };
    } catch {
      return { kind: "offline", copy: !!(await offlineCopy().catch(() => null)) };
    }
  }, [api, restore]);

  const check = useCallback(async () => setPhase(await firstPhase()), [firstPhase]);

  useEffect(() => {
    let alive = true;
    void firstPhase().then((p) => alive && setPhase(p));
    return () => {
      alive = false;
    };
  }, [firstPhase]);

  const signOut = useCallback(async () => {
    try {
      await ops.signOut(api);
    } finally {
      setPhase({ kind: "gate", mode: "signin" });
    }
  }, [api]);

  return (
    <div className="vault" data-phase={phase.kind} data-consent={consent !== undefined ? "true" : undefined}>
      <div className="container">
        {phase.kind === "checking" ? <Spinner label="Checking your session" /> : null}
        {phase.kind === "offline" ? (
          <div className="vault-gate">
            <Notice kind="error">Sigil could not be reached. Check your connection and try again.</Notice>
            <div className="row">
              <button type="button" className="button" onClick={() => void check()}>
                Try again
              </button>
              {phase.copy ? (
                <button type="button" className="button button-primary" onClick={() => setPhase({ kind: "offline-copy" })}>
                  Read the copy on this device
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {phase.kind === "offline-copy" ? <OfflineVault onBack={() => void check()} /> : null}
        {phase.kind === "restore" ? (
          <RestoreApp
            api={api}
            onOpened={(vault) => {
              window.history.replaceState(null, "", "/vault#storage");
              setPhase({ kind: "open", vault });
            }}
            onBack={() => {
              window.history.replaceState(null, "", "/vault");
              setPhase({ kind: "gate", mode: "signin" });
            }}
          />
        ) : null}
        {phase.kind === "gate" ? (
          <Gate
            api={api}
            mode={phase.mode}
            onMode={(mode) => setPhase({ kind: "gate", mode })}
            onCreated={({ vault, phrase }) => setPhase({ kind: "phrase", vault, phrase })}
            onUnlocked={(vault) => setPhase({ kind: "open", vault })}
            onSignOut={() => void signOut()}
          />
        ) : null}
        {phase.kind === "phrase" ? (
          <div className="vault-gate">
            <PhraseScreen phrase={phase.phrase} title="Save your recovery phrase" onDone={() => setPhase({ kind: "open", vault: phase.vault })} />
          </div>
        ) : null}
        {phase.kind === "open" && consent !== undefined ? <Consent api={api} vault={phase.vault} request={consent} /> : null}
        {phase.kind === "open" && consent === undefined ? (
          <Dashboard api={api} vault={phase.vault} onLock={() => setPhase({ kind: "gate", mode: "unlock" })} onSignOut={signOut} onDeleted={() => setPhase({ kind: "gate", mode: "create" })} />
        ) : null}
      </div>
    </div>
  );
}
