"use client";

import { useState } from "react";
import { PasskeyIcon, PhraseIcon, WalletIcon } from "@/components/icons";
import { formatBytes, formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { browserPasskeys, passkeysAvailable } from "../passkey";
import { connectWallet, signVaultMessage, WalletRedirect } from "../wallet";
import { PhraseScreen } from "../PhraseScreen";
import { errorText, useVault } from "../context";
import { download, Notice } from "../ui";
import { clearVectorCache } from "../semantic";
import { guideOpen, saveGuide } from "../guideOps";
import { newGuide } from "@sigil/core";

const CONFIRM_WORDS = "delete my vault";

export function SettingsTab({ onDeleted }: { onDeleted(): void }) {
  const { api, vault, data, update, lock, signOut, goTo } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newPhrase, setNewPhrase] = useState<string | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState("");

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof WalletRedirect)) setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const setSlots = (keyslots: ops.KeyslotView[]) => update((d) => ({ ...d, keyslots }));

  if (newPhrase) {
    return (
      <PhraseScreen
        phrase={newPhrase}
        title="Your new recovery phrase"
        doneLabel="Back to settings"
        onDone={() => {
          setNewPhrase(null);
          setMessage("Your new recovery phrase is active. The old one no longer works.");
        }}
      />
    );
  }

  const slotLabel = (s: ops.KeyslotView) =>
    s.kind === "passkey" ? "Passkey" : s.kind === "wallet" ? `Wallet ${s.label ? `${s.label.slice(0, 6)}...${s.label.slice(-4)}` : ""}` : "Recovery phrase";
  const SlotIcon = (s: ops.KeyslotView) => (s.kind === "passkey" ? <PasskeyIcon /> : s.kind === "wallet" ? <WalletIcon /> : <PhraseIcon />);

  return (
    <div className="settings">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      <section className="settings-section" aria-labelledby="s-methods">
        <div className="panel-header">
          <h2 id="s-methods" className="panel-title">
            Ways into your vault
          </h2>
        </div>
        <p className="small muted">
          Each one holds its own locked copy of your vault key. Keep at least two, so losing one device does not lock you out. Devices added by QR code are under{" "}
          <button type="button" className="text-button" onClick={() => goTo("devices")}>
            Devices
          </button>
          .
        </p>
        <ul className="list">
          {data.keyslots.filter((s) => s.kind !== "device").map((s) => (
            <li key={s.id} className="list-row">
              <div className="list-row-main">
                <p className="list-row-title">
                  {SlotIcon(s)} {slotLabel(s)}
                </p>
                <p className="list-row-meta">
                  Added {formatDateTime(s.createdAt)}. {s.lastUsedAt ? `Last used ${formatDateTime(s.lastUsedAt)}.` : "Not used to sign in yet."}
                </p>
                {removing === s.id ? (
                  <div className="row form-actions">
                    <button
                      type="button"
                      className="button button-small button-danger"
                      disabled={!!busy}
                      onClick={() =>
                        void act("remove", async () => {
                          setSlots(await ops.removeKeyslot(api, s.id));
                          setRemoving(null);
                        })
                      }
                    >
                      Remove {slotLabel(s).toLowerCase()}
                    </button>
                    <button type="button" className="button button-small button-ghost" onClick={() => setRemoving(null)}>
                      Keep it
                    </button>
                  </div>
                ) : null}
              </div>
              {removing !== s.id ? (
                <div className="list-row-actions">
                  {s.kind === "phrase" ? (
                    <button type="button" className="button button-small" onClick={() => setConfirmPhrase(true)} disabled={!!busy}>
                      Replace
                    </button>
                  ) : (
                    <button type="button" className="button button-small button-ghost" onClick={() => setRemoving(s.id)} disabled={!!busy}>
                      Remove
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {confirmPhrase ? (
          <div className="subpanel">
            <p className="small">Make a new recovery phrase? The current one stops working as soon as the new one is made.</p>
            <div className="row">
              <button
                type="button"
                className="button button-small button-primary"
                disabled={!!busy}
                onClick={() =>
                  void act("phrase", async () => {
                    const phrase = await ops.replaceRecoveryPhrase(api, vault);
                    setConfirmPhrase(false);
                    setNewPhrase(phrase);
                    setSlots((await api.get<{ keyslots: ops.KeyslotView[] }>("keyslots")).keyslots);
                  })
                }
              >
                Make a new phrase
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setConfirmPhrase(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <div className="row form-actions">
          <button
            type="button"
            className="button button-small"
            disabled={!!busy}
            onClick={() =>
              void act("passkey", async () => {
                if (!passkeysAvailable()) throw new Error("This browser does not support passkeys.");
                setSlots(await ops.addPasskey(api, vault, browserPasskeys));
                setMessage("Passkey added.");
              })
            }
          >
            <PasskeyIcon /> {busy === "passkey" ? "Waiting for passkey" : "Add a passkey"}
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={!!busy}
            onClick={() =>
              void act("wallet", async () => {
                const { provider, address } = await connectWallet();
                const first = await signVaultMessage(provider, address);
                const second = await signVaultMessage(provider, address);
                ops.assertStableSignature(first, second);
                setSlots(await ops.addWallet(api, vault, address, first));
                setMessage("Wallet added.");
              })
            }
          >
            <WalletIcon /> {busy === "wallet" ? "Waiting for wallet" : "Add a wallet"}
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="s-export">
        <h2 id="s-export" className="panel-title">
          Export
        </h2>
        <p className="small muted">
          Download everything in your vault, decrypted on this device, as one JSON file: {plural(data.memories.length, "memory", "memories")},{" "}
          {plural(data.folders.length, "folder")}, your apps and the read log. Keep the file safe; it is not encrypted.
        </p>
        <button
          type="button"
          className="button"
          disabled={!!busy}
          onClick={() =>
            void act("export", async () => {
              const log = await ops.loadLog(api, 1000);
              const out = ops.buildExport(data, log.entries);
              download(`sigil-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2));
            })
          }
        >
          {busy === "export" ? "Preparing" : "Download everything"}
        </button>
      </section>

      <section className="settings-section" aria-labelledby="s-session">
        <h2 id="s-session" className="panel-title">
          This device
        </h2>
        <p className="small muted">
          Your vault holds {formatBytes(data.usage.bytes)} of encrypted data. Locking forgets the key on this page; signing out also ends the session.
        </p>
        <div className="row">
          <button type="button" className="button" onClick={lock}>
            Lock vault
          </button>
          <button type="button" className="button button-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="s-guide">
        <h2 id="s-guide" className="panel-title">
          Getting started
        </h2>
        <p className="small muted">The short guide from the first day: your recovery phrase, your history, one AI app and its first answer. It keeps your place.</p>
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={busy === "guide" || guideOpen(data)}
            onClick={() =>
              void act("guide", async () => {
                const next = await saveGuide(api, vault, data.guide ? { ...data.guide, dismissed: false } : newGuide(false));
                update((d) => ({ ...d, guide: next }));
              })
            }
          >
            {guideOpen(data) ? "The guide is open above" : "Show the guide again"}
          </button>
        </div>
      </section>

      <section className="settings-section subpanel danger-zone" aria-labelledby="s-delete">
        <h2 id="s-delete" className="panel-title">
          Delete your vault
        </h2>
        <p className="small muted">
          Deletes your account, every memory, folder, app and read-log entry, and every way to sign in. It cannot be undone and Sigil cannot recover
          it. Connected apps stop working at once.
        </p>
        <div className="field">
          <label className="field-label" htmlFor="delete-confirm">
            Type &quot;{CONFIRM_WORDS}&quot; to confirm
          </label>
          <input id="delete-confirm" className="input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" />
        </div>
        <button
          type="button"
          className="button button-danger"
          disabled={!!busy || deleteText.trim().toLowerCase() !== CONFIRM_WORDS}
          onClick={() =>
            void act("delete", async () => {
              await ops.deleteAccount(api);
              await clearVectorCache();
              onDeleted();
            })
          }
        >
          {busy === "delete" ? "Deleting" : "Delete everything"}
        </button>
      </section>
    </div>
  );
}
