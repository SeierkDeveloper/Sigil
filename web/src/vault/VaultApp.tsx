"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi } from "./api";
import * as ops from "./ops";
import { Gate, type GateMode } from "./Gate";
import { PhraseScreen } from "./PhraseScreen";
import { Dashboard } from "./Dashboard";
import { Consent, type ConsentRequest } from "./Consent";
import { Notice, Spinner } from "./ui";

type Phase =
  | { kind: "checking" }
  | { kind: "offline" }
  | { kind: "gate"; mode: GateMode }
  | { kind: "phrase"; vault: ops.Unlocked; phrase: string }
  | { kind: "open"; vault: ops.Unlocked };

/**
 * The vault page. The vault key lives only in this component's memory: closing
 * or reloading the page locks the vault again. With a consent request it is the
 * Sign in with Sigil window: once open, it asks about one web app instead of
 * showing the dashboard.
 */
export function VaultApp({ consent }: { consent?: ConsentRequest | null } = {}) {
  const api = useMemo(() => createApi(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  const check = useCallback(async () => {
    try {
      const s = await api.get<{ signedIn: boolean }>("session");
      setPhase({ kind: "gate", mode: s.signedIn ? "unlock" : "create" });
    } catch {
      setPhase({ kind: "offline" });
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    api
      .get<{ signedIn: boolean }>("session")
      .then((s) => alive && setPhase({ kind: "gate", mode: s.signedIn ? "unlock" : "create" }))
      .catch(() => alive && setPhase({ kind: "offline" }));
    return () => {
      alive = false;
    };
  }, [api]);

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
            <button type="button" className="button" onClick={() => void check()}>
              Try again
            </button>
          </div>
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
