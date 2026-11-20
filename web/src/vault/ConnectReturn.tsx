"use client";

// The small window that live sync opens lands here after the sign-in. It hands
// the code to the vault page that opened it (same origin only, never anywhere
// else) and closes. The code is useless without the verifier, which never left
// that page.

import { useEffect } from "react";
import { SyncIcon } from "@/components/icons";
import { CONNECT_CHANNEL, type ConnectMessage } from "./syncOps";

export function ConnectReturn() {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const message: ConnectMessage = { type: "sigil-connect", code: q.get("code"), state: q.get("state"), error: q.get("error_description") ?? q.get("error") };
    // The code leaves the address bar and history at once.
    window.history.replaceState(null, "", window.location.pathname);
    if (!message.state) return;
    if (window.opener) (window.opener as Window).postMessage(message, window.location.origin);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CONNECT_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
    window.setTimeout(() => window.close(), 300);
  }, []);
  return (
    <div className="container ask-page connect-return">
      <div className="vault-gate ask-card connect-card" data-state="active">
        <header className="ask-head">
          <span className="ask-seal" aria-hidden="true">
            <SyncIcon />
          </span>
          <p className="eyebrow">Live sync</p>
          <h1 className="page-title">Signing in</h1>
        </header>
        <span className="connect-wire" aria-hidden="true" />
        <p className="page-lead">Your vault takes it from here, and this window closes on its own. If it stays open, close it and connect the source again under Sync.</p>
      </div>
    </div>
  );
}
