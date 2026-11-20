"use client";

// Restoring a vault on this node, or arriving here from another node. The
// bundle is read from a file on this device, or fetched by this node from an
// address (an IPFS or Arweave gateway, a bucket address presigned here), or,
// for a move, from the old node with the move code. It is opened and checked
// in full here with the owner's recovery phrase or wallet, and only then
// handed to this node with a statement signed for it.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cleanTarget, signingFingerprint, verifyBundle, type SignedMove, type VaultBundle, type S3Target } from "@sigil/core";
import { NodeIcon, PhraseIcon, WalletIcon, ArrowIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import type { Api } from "./api";
import * as ops from "./ops";
import * as storage from "./storageOps";
import * as nodes from "./nodeOps";
import { connectWallet, listenForWallets, signVaultMessage, WalletRedirect } from "./wallet";
import { errorText } from "./context";
import { Fingerprint, Notice } from "./ui";

type Source = "file" | "url" | "ipfs" | "arweave" | "s3";
const subscribe = () => () => undefined;

interface Loaded {
  bundle: VaultBundle;
  move: { code: string; move: SignedMove } | null;
}

export function RestoreApp({ api, onOpened, onBack }: { api: Api; onOpened(vault: ops.Unlocked): void; onBack(): void }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const [source, setSource] = useState<Source>("file");
  const [url, setUrl] = useState("");
  const [cid, setCid] = useState("");
  const [gateway, setGateway] = useState("");
  const [s3, setS3] = useState({ endpoint: "", region: "", bucket: "", key: "", accessKeyId: "", secretAccessKey: "" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: storage.RestoreResult; vault: ops.Unlocked } | null>(null);

  useEffect(() => listenForWallets(), []);

  // A move code opened from the old node: fetch the move at once.
  const moveCode = useMemo(() => (hash ? new URLSearchParams(hash.replace(/^#/, "")).get("move") : null), [hash]);
  const [moveFailed, setMoveFailed] = useState(false);
  useEffect(() => {
    if (!moveCode) return;
    let alive = true;
    nodes
      .fetchArrival(api, moveCode)
      .then((got) => alive && setLoaded({ bundle: got.bundle, move: { code: moveCode, move: got.move } }))
      .catch((err) => {
        if (!alive) return;
        setError(errorText(err));
        setMoveFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [api, moveCode]);
  const arriving = !!moveCode && !loaded && !moveFailed && !done;

  const load = async (fn: () => Promise<VaultBundle>) => {
    setBusy("load");
    setError(null);
    try {
      setLoaded({ bundle: await fn(), move: null });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const open = async (how: storage.RestoreSignIn) => {
    if (!loaded) return;
    const origin = window.location.origin;
    if (loaded.move) {
      const r = await nodes.arrive(api, loaded.move.code, loaded.move.move, loaded.bundle, how, origin);
      window.history.replaceState(null, "", "/vault/restore");
      setDone({ result: r.result, vault: r.opened.vault });
    } else {
      const opened = await storage.openForRestore(loaded.bundle, how);
      const result = await storage.restoreHere(api, opened, loaded.bundle, origin);
      setDone({ result, vault: opened.vault });
    }
  };

  const signIn = async (which: "phrase" | "wallet") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "phrase") await open({ kind: "phrase", phrase });
      else {
        const { provider, address } = await connectWallet();
        await open({ kind: "wallet", address, signature: await signVaultMessage(provider, address) });
      }
    } catch (err) {
      if (!(err instanceof WalletRedirect)) setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const check = loaded ? verifyBundle(loaded.bundle) : null;

  return (
    <section className="vault-gate restore" aria-labelledby="restore-title" data-state={done ? "done" : loaded ? "loaded" : "source"}>
      <span className="ask-seal" aria-hidden="true">
        <NodeIcon />
      </span>
      <h1 id="restore-title" className="vault-gate-title">
        {loaded?.move ? "Move your vault here" : "Restore a vault"}
      </h1>
      <p className="muted">
        {loaded?.move
          ? `Your vault is coming from ${loaded.move.move.statement.from}. Sign in with your recovery phrase or wallet: the bundle is opened and checked on this device, then this node takes it in and tells the old node.`
          : "From a bundle you kept: a file, or a copy in your own storage. It opens only with your recovery phrase or wallet, on this device. This node never sees what is in it."}
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {done ? (
        <div className="restore-done" data-testid="restore-done">
          <Notice kind="success">
            {done.result.report.folders} folders and {plural(done.result.report.memories, "memory", "memories")} restored, with {plural(done.result.report.logEntries, "entry", "entries")} of your read
            log and their proofs.
            {Object.keys(done.result.report.left).length ? ` Some parts stay behind (${Object.entries(done.result.report.left).map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`).join(", ")}): they point to things this node does not hold.` : ""}
            {done.result.confirmed === true ? " The old node confirmed the move and sends your links on here." : ""}
            {done.result.confirmed === false ? " The old node could not be told yet; your vault tries again under Storage." : ""}
          </Notice>
          <button type="button" className="button button-primary" onClick={() => onOpened(done.vault)}>
            Open your vault
          </button>
        </div>
      ) : loaded && check ? (
        <>
          <dl className="public-facts restore-facts" data-testid="restore-facts">
            <div>
              <dt>Made</dt>
              <dd>{formatDateTime(loaded.bundle.body.createdAt)}</dd>
            </div>
            <div>
              <dt>Folders</dt>
              <dd>{loaded.bundle.body.folders.length}</dd>
            </div>
            <div>
              <dt>Memories</dt>
              <dd>{loaded.bundle.body.memories.length}</dd>
            </div>
          </dl>
          <p className="small muted">
            From {loaded.bundle.body.origin}, {loaded.bundle.signature ? "signed by the vault key " : "made by a connector, for the vault key "}
            <Fingerprint value={signingFingerprint(loaded.bundle.body.vault.signKey)} />. {check.ok ? "Its hash covers every part." : `It did not pass its checks: ${check.checks.find((c) => !c.ok)?.detail}`}
          </p>
          {check.ok ? (
            <div className="method-list">
              <form
                className="subpanel"
                onSubmit={(e) => {
                  e.preventDefault();
                  void signIn("phrase");
                }}
              >
                <div className="field">
                  <label className="field-label" htmlFor="restore-phrase">
                    <PhraseIcon /> Recovery phrase
                  </label>
                  <textarea id="restore-phrase" className="textarea" rows={3} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
                  <span className="field-hint">Turned into keys in this browser. It is never sent.</span>
                </div>
                <button type="submit" className="button button-primary" disabled={!!busy || phrase.trim().split(/\s+/).length < 24}>
                  {busy === "phrase" ? "Opening and checking" : "Open with my phrase"}
                </button>
              </form>
              <button type="button" className="method" onClick={() => void signIn("wallet")} disabled={!!busy} data-testid="restore-wallet">
                <WalletIcon className="method-icon" />
                <span>
                  <span className="method-title">Open with my wallet</span>
                  <span className="method-text">The wallet the vault was made with, or one you added to it.</span>
                </span>
                {busy === "wallet" ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon />}
              </button>
            </div>
          ) : null}
        </>
      ) : busy === "load" || arriving ? (
        <div className="loading" role="status">
          <span className="spinner" aria-hidden="true" /> Reading the bundle
        </div>
      ) : (
        <>
          <div className="segmented" role="group" aria-label="Where the bundle is">
            {(
              [
                ["file", "A file"],
                ["url", "A link"],
                ["ipfs", "IPFS"],
                ["arweave", "Arweave"],
                ["s3", "My bucket"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={source === k} onClick={() => setSource(k)}>
                {label}
              </button>
            ))}
          </div>
          {source === "file" ? (
            <div className="field">
              <label className="field-label" htmlFor="restore-file">
                The bundle file
              </label>
              <input
                id="restore-file"
                className="input"
                type="file"
                accept=".sigil,application/octet-stream,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void load(async () => storage.loadBundle({ kind: "file", bytes: new Uint8Array(await f.arrayBuffer()) }));
                }}
              />
            </div>
          ) : (
            <form
              className="restore-source"
              onSubmit={(e) => {
                e.preventDefault();
                void load(async () => {
                  if (source === "url") return storage.loadBundle({ kind: "url", url });
                  if (source === "ipfs") return storage.loadBundle({ kind: "ipfs", cid, gateway: gateway || "https://ipfs.io" });
                  if (source === "arweave") return storage.loadBundle({ kind: "arweave", id: cid, gateway: gateway || "https://arweave.net" });
                  const target = cleanTarget({ kind: "s3", label: "Bucket", ...s3 }) as S3Target;
                  return storage.loadBundle({ kind: "s3", target, key: s3.key });
                });
              }}
            >
              {source === "url" ? (
                <div className="field">
                  <label className="field-label" htmlFor="restore-url">
                    Address of the bundle
                  </label>
                  <input id="restore-url" className="input" type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
                </div>
              ) : null}
              {source === "ipfs" || source === "arweave" ? (
                <div className="grid grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="restore-cid">
                      {source === "ipfs" ? "Content id" : "Transaction id"}
                    </label>
                    <input id="restore-cid" className="input mono" value={cid} onChange={(e) => setCid(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="restore-gateway">
                      Gateway
                    </label>
                    <input id="restore-gateway" className="input" type="url" value={gateway} placeholder={source === "ipfs" ? "https://ipfs.io" : "https://arweave.net"} onChange={(e) => setGateway(e.target.value)} />
                  </div>
                </div>
              ) : null}
              {source === "s3" ? (
                <>
                  <p className="small muted">The keys stay on this device: it makes an address that works for fifteen minutes, which this node fetches.</p>
                  <div className="grid grid-2">
                    {(
                      [
                        ["endpoint", "Service address"],
                        ["region", "Region"],
                        ["bucket", "Bucket"],
                        ["key", "Object name"],
                        ["accessKeyId", "Access key id"],
                        ["secretAccessKey", "Secret key"],
                      ] as const
                    ).map(([k, label]) => (
                      <div className="field" key={k}>
                        <label className="field-label" htmlFor={`restore-s3-${k}`}>
                          {label}
                        </label>
                        <input
                          id={`restore-s3-${k}`}
                          className="input"
                          type={k === "secretAccessKey" ? "password" : "text"}
                          autoComplete="off"
                          value={s3[k]}
                          onChange={(e) => setS3({ ...s3, [k]: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <button type="submit" className="button button-primary">
                Read the bundle
              </button>
            </form>
          )}
        </>
      )}
      <p className="small muted gate-signout">
        <button type="button" className="text-button" onClick={onBack}>
          Back to sign in
        </button>
      </p>
    </section>
  );
}
