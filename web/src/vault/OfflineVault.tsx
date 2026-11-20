"use client";

import { useEffect, useMemo, useState } from "react";
import { isValidPhrase, passkeyKek, phraseKeys, randomBytes, search, toBase64Url, unwrapVaultKey, vaultCryptoKey, walletKeys, type Memory } from "@sigil/core";
import { PasskeyIcon, PhoneIcon, PhraseIcon, WalletIcon } from "@/components/icons";
import { formatDate, formatDateTime } from "@/lib/format";
import * as ops from "./ops";
import { browserPasskeys } from "./passkey";
import { connectWallet, signVaultMessage } from "./wallet";
import { deriveFromDevice, offlineCopy, thisDevice, type OfflineCopy } from "./offline";
import { errorText } from "./context";
import { Notice, Spinner } from "./ui";

/**
 * The copy of the vault kept on this device, opened without the network. The
 * same keys as online: the locked vault key for the way this device last signed
 * in, opened with that passkey, wallet, phrase or device key. Read only.
 */
export function OfflineVault({ onBack }: { onBack(): void }) {
  const [copy, setCopy] = useState<OfflineCopy | null | undefined>(undefined);
  const [data, setData] = useState<ops.VaultData | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    offlineCopy()
      .then((c) => alive && setCopy(c))
      .catch(() => alive && setCopy(null));
    return () => {
      alive = false;
    };
  }, []);

  const open = async (kek: () => Promise<Uint8Array>) => {
    if (!copy) return;
    setBusy(true);
    setError(null);
    try {
      const raw = await unwrapVaultKey(await kek(), copy.keyslot.wrappedKey, copy.keyslot.kind);
      setData(await ops.decodeVault(copy.server, { raw, key: await vaultCryptoKey(raw) }, null));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (copy === undefined) return <Spinner label="Looking for the copy on this device" />;
  if (!copy) {
    return (
      <div className="vault-gate">
        <Notice>This device keeps no copy of your vault.</Notice>
        <button type="button" className="button" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  if (data) return <OfflineList data={data} savedAt={copy.savedAt} onBack={onBack} />;

  const kind = copy.keyslot.kind;
  return (
    <section className="vault-gate offline-gate" aria-labelledby="offline-title">
      <h1 id="offline-title" className="vault-gate-title">
        Your vault, offline
      </h1>
      <p className="muted">A copy from {formatDateTime(copy.savedAt)}, kept on this device as ciphertext. Open it the way you last signed in here. It is read only until you are back online.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="method-list">
        {kind === "device" ? (
          <button
            type="button"
            className="method"
            disabled={busy}
            onClick={() =>
              void open(async () => {
                const d = await thisDevice();
                if (!d) throw new Error("This browser no longer holds the device key.");
                return deriveFromDevice(d.key, "sigil:kek:device");
              })
            }
          >
            <PhoneIcon className="method-icon" />
            <span>
              <span className="method-title">Open with this device</span>
              <span className="method-text">The device key this browser keeps.</span>
            </span>
          </button>
        ) : null}
        {kind === "passkey" ? (
          <button
            type="button"
            className="method"
            disabled={busy}
            onClick={() =>
              void open(async () => {
                const got = await browserPasskeys.get({ challenge: toBase64Url(randomBytes(32)), rpId: window.location.hostname, userVerification: "required" });
                if (!got.prf) throw new Error("This passkey did not give a key.");
                return passkeyKek(got.prf);
              })
            }
          >
            <PasskeyIcon className="method-icon" />
            <span>
              <span className="method-title">Use your passkey</span>
              <span className="method-text">It works without the network.</span>
            </span>
          </button>
        ) : null}
        {kind === "wallet" && copy.keyslot.address ? (
          <button
            type="button"
            className="method"
            disabled={busy}
            onClick={() =>
              void open(async () => {
                const { provider, address } = await connectWallet();
                if (address.toLowerCase() !== copy.keyslot.address!.toLowerCase()) throw new Error("This copy opens with another wallet.");
                return (await walletKeys(address, await signVaultMessage(provider, address))).kek;
              })
            }
          >
            <WalletIcon className="method-icon" />
            <span>
              <span className="method-title">Use your wallet</span>
              <span className="method-text">A signature, never a transaction.</span>
            </span>
          </button>
        ) : null}
      </div>
      {kind === "phrase" ? (
        <form
          className="subpanel"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isValidPhrase(phrase)) return setError("That is not a valid recovery phrase.");
            void open(async () => (await phraseKeys(phrase)).kek);
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="offline-phrase">
              <PhraseIcon /> Recovery phrase
            </label>
            <textarea id="offline-phrase" className="textarea" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <button type="submit" className="button button-primary" disabled={busy}>
            Open the copy
          </button>
        </form>
      ) : null}
      <p className="small muted gate-signout">
        <button type="button" className="text-button" onClick={onBack}>
          Back
        </button>
      </p>
    </section>
  );
}

function OfflineList({ data, savedAt, onBack }: { data: ops.VaultData; savedAt: string; onBack(): void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Memory | null>(null);
  const names = useMemo(() => new Map(data.folders.map((f) => [f.id, f.name])), [data.folders]);
  const shown = useMemo(
    () =>
      query.trim()
        ? search(
            data.memories.map((m) => ({ ...m, text: m.body })),
            query,
            50,
          ).map((h) => h.item as Memory)
        : data.memories.slice(0, 200),
    [data.memories, query],
  );
  return (
    <div className="dashboard offline-vault">
      <div className="dashboard-bar">
        <div>
          <h1 className="dashboard-title">Your vault, offline</h1>
          <div className="dashboard-stats">
            <span>Copy from {formatDateTime(savedAt)}</span>
            <span>Read only</span>
          </div>
        </div>
        <button type="button" className="button button-small" onClick={onBack}>
          Close
        </button>
      </div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="offline-search">
          Search
        </label>
        <input id="offline-search" className="input search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, tags and text on this device" />
      </div>
      <div className="memory-layout">
        <ul className="memory-list">
          {shown.map((m) => (
            <li key={m.id}>
              <button type="button" className="memory-item" aria-current={open?.id === m.id ? "true" : undefined} onClick={() => setOpen(m)}>
                <span className="memory-item-title">{m.title}</span>
                <span className="memory-item-meta">
                  {names.get(m.folderId)}, {formatDate(m.editedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {open ? (
          <article className="editor editor-readonly">
            <h2 className="editor-title">{open.title}</h2>
            <p className="editor-meta">
              In {names.get(open.folderId)}. Edited {formatDateTime(open.editedAt)}.
            </p>
            <div className="editor-body">{open.body}</div>
          </article>
        ) : (
          <p className="muted small">Choose a memory to read it.</p>
        )}
      </div>
    </div>
  );
}
