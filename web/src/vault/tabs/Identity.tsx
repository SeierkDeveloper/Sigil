"use client";

import { useEffect, useMemo, useState } from "react";
import {
  checkCall,
  cleanWalletRules,
  EMPTY_RULES,
  formatUnits,
  signingFingerprint,
  verifyIdentityStatement,
  walletRulesHash,
  type RulesContract,
  type RulesRecipient,
  type RulesToken,
  type WalletRules,
} from "@sigil/core";
import { IdentityIcon, ImportIcon } from "@/components/icons";
import { formatDate, formatDateTime } from "@/lib/format";
import * as idOps from "../identityOps";
import { errorText, useVault } from "../context";
import { Band, CopyButton, download, Empty, Notice, PlateHead, Quiet } from "../ui";

/** The AI self's identity: its own key, a statement signed by that key and the vault, and the rules of its wallet. */
export function IdentityTab() {
  const { api } = useVault();
  const [chain, setChain] = useState<idOps.ChainConfig | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api
      .get<{ chain: idOps.ChainConfig | null }>("identity/config")
      .then((r) => alive && setChain(r.chain))
      .catch(() => alive && setChain(null));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <div className="identity">
      <div className="panel-header">
        <h2 className="panel-title">Identity</h2>
        <p className="small muted">
          Your AI self gets a key of its own, made on this device from your vault key and never stored anywhere. Its address is the self&apos;s identity on any EVM chain. A
          statement signed by that key and by your vault says the two belong together, and a wallet for the self follows rules only you can change.
        </p>
      </div>
      {chain === null ? (
        <Notice>
          <span data-testid="identity-offchain">
            This site has no registry of AI selves on chain yet. Everything below works without one: the self&apos;s key, its signed statement, and the wallet rules as a draft
            you keep. Once the site&apos;s owner deploys the registry and sets its address, you can register the self here with your own wallet.
          </span>
        </Notice>
      ) : null}
      <KeySection />
      <StatementSection chain={chain ?? null} />
      <RulesSection />
      <ChainSection chain={chain ?? null} />
    </div>
  );
}

function KeySection() {
  const { api, vault, data, update } = useVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="subpanel plate identity-key" aria-labelledby="self-key-title">
      <PlateHead number="01" id="self-key-title" title="The self's key" lead="Derived from your vault key on this device: the same vault always gives the same key.">
        <span className="plate-state" data-on={data.identity ? "true" : "false"}>
          {data.identity ? "Made" : "Not yet"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data.identity ? (
        <dl className="identity-facts">
          <div>
            <dt>Address</dt>
            <dd>
              <code className="mono identity-address" data-testid="self-address">
                {data.identity.address}
              </code>
            </dd>
          </div>
          <div>
            <dt>Made</dt>
            <dd>{formatDate(data.identity.createdAt)}</dd>
          </div>
          {data.signKey ? (
            <div>
              <dt>Vault key</dt>
              <dd className="mono">{signingFingerprint(data.signKey)}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <Empty icon={<IdentityIcon />} title="No key yet">
          Make it once. Only its address leaves this device.
        </Empty>
      )}
      {!data.identity ? (
        <div className="form-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const identity = await idOps.makeSelfKey(api, vault);
                update((d) => ({ ...d, identity }));
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <IdentityIcon /> {busy ? "Making" : "Make the self's key"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StatementSection({ chain }: { chain: idOps.ChainConfig | null }) {
  const { api, vault, data, update } = useVault();
  const [form, setForm] = useState<idOps.IdentityChoices>({ ...data.identityChoices, name: data.identityChoices.name || data.self?.name || "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const st = data.identity?.statement ?? null;
  const check = useMemo(() => (st ? verifyIdentityStatement(st) : null), [st]);
  const url = data.identity ? idOps.metadataUrl(origin, data.identity.address) : "";

  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("sign");
    setError(null);
    try {
      const choices = await idOps.saveChoices(api, vault, form);
      const identity = await idOps.signStatement(api, vault, choices, chain, origin);
      update((d) => ({ ...d, identity, identityChoices: choices }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate identity-statement" aria-labelledby="statement-title">
      <PlateHead number="02" id="statement-title" title="Identity statement" lead="What you say about the self, signed by its key and by your vault. Anyone can read it at its address and check both signatures.">
        <span className="plate-state" data-on={st ? "true" : "false"}>
          {st ? "Signed" : "Not signed"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data.identity ? <Quiet>Make the self&apos;s key first.</Quiet> : null}
      {data.identity ? (
        <form onSubmit={sign} aria-label="Identity statement">
          <Band label="Who it is">
            <div className="field">
              <label className="field-label" htmlFor="id-name">
                Name it goes by
              </label>
              <input id="id-name" className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="id-about">
                What it is for
              </label>
              <textarea id="id-about" className="textarea" rows={2} value={form.about} maxLength={400} onChange={(e) => setForm({ ...form, about: e.target.value })} />
            </div>
          </Band>
          <Band label="On chain" hint="Optional. Your own address registers the self; the wallet is the one it may use.">
            <div className="field">
              <label className="field-label" htmlFor="id-owner">
                Your own address
              </label>
              <input id="id-owner" className="input mono" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="0x..." spellCheck={false} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="id-wallet">
                The self&apos;s wallet
              </label>
              <input id="id-wallet" className="input mono" value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })} placeholder="0x..." spellCheck={false} />
            </div>
          </Band>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!!busy || !form.name.trim()}>
              {busy === "sign" ? "Signing" : st ? "Sign a new statement" : "Sign the statement"}
            </button>
          </div>
        </form>
      ) : null}
      {st && check ? (
        <div className="identity-signed" data-testid="identity-statement" data-ok={check.ok ? "true" : "false"}>
          <ul className="proof-steps">
            {check.checks.map((c) => (
              <li key={c.name} data-ok={c.ok ? "true" : "false"}>
                {c.detail}
              </li>
            ))}
          </ul>
          <p className="small muted">
            Signed {formatDateTime(st.body.issuedAt)} as {st.body.name}. Its address, for the registry&apos;s metadata:
          </p>
          <div className="certificate-link">
            <code className="mono small">{url}</code>
            <CopyButton text={url} />
          </div>
          <div className="row">
            <button type="button" className="button button-small" onClick={() => download(`sigil-identity-${st.body.selfKey.slice(0, 10)}.json`, JSON.stringify(st, null, 2))}>
              <ImportIcon /> Download
            </button>
            <button
              type="button"
              className="button button-small button-ghost"
              disabled={!!busy}
              onClick={async () => {
                setBusy("withdraw");
                try {
                  await idOps.withdrawStatement(api);
                  update((d) => ({ ...d, identity: d.identity ? { ...d.identity, statement: null } : null }));
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Withdraw it
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- wallet rules

const emptyRecipient = (): RulesRecipient => ({ address: "", label: "" });
const emptyContract = (): RulesContract => ({ address: "", label: "", functions: [] });
const emptyToken = (): RulesToken => ({ address: "", label: "", decimals: 18, perTx: "0", perDay: "0" });

function RulesSection() {
  const { api, vault, data, update } = useVault();
  const [rules, setRules] = useState<WalletRules>(data.walletRules ?? EMPTY_RULES);
  const [fns, setFns] = useState<string[]>((data.walletRules?.contracts ?? []).map((c) => c.functions.join(", ")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [trial, setTrial] = useState({ target: "", value: "" });

  const draft = (): WalletRules => ({
    ...rules,
    contracts: rules.contracts.map((c, i) => ({
      ...c,
      functions: (fns[i] ?? "")
        .split(/,(?![^(]*\))/)
        .map((f) => f.trim())
        .filter(Boolean),
    })),
  });
  let fingerprint: string | null = null;
  let problem: string | null = null;
  try {
    fingerprint = walletRulesHash(draft());
  } catch (err) {
    problem = errorText(err);
  }
  let trialResult: string | null = null;
  let trialOk = false;
  if (trial.target.trim() && !problem) {
    const r = checkCall(draft(), { target: trial.target.trim(), value: trial.value || "0", fn: "" });
    trialOk = r.ok;
    trialResult = r.ok ? "The wallet would let the self send this." : r.reason;
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clean = await idOps.saveRules(api, vault, cleanWalletRules(draft()));
      update((d) => ({ ...d, walletRules: clean }));
      setRules(clean);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const setAt = <K extends "recipients" | "contracts" | "tokens">(k: K, i: number, v: WalletRules[K][number]) => setRules({ ...rules, [k]: rules[k].map((x, j) => (j === i ? v : x)) });
  const drop = (k: "recipients" | "contracts" | "tokens", i: number) => {
    setRules({ ...rules, [k]: rules[k].filter((_, j) => j !== i) });
    if (k === "contracts") setFns(fns.filter((_, j) => j !== i));
  };

  return (
    <form className="subpanel plate identity-rules" onSubmit={save} aria-label="Wallet rules">
      <PlateHead number="03" id="rules-title" title="Wallet rules" lead="What the self may spend and where. Kept encrypted in your vault; the self's wallet on chain follows the same rules once you set them there.">
        <span className="plate-state" data-on={data.walletRules ? "true" : "false"}>
          {data.walletRules ? "Draft saved" : "No draft"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">Rules saved.</Notice> : null}
      <Band label="Caps" hint="In the chain's own coin, for example ether. Zero lets the self make calls that move no value.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="rules-tx">
              Per payment
            </label>
            <input id="rules-tx" className="input" inputMode="decimal" value={rules.perTx} onChange={(e) => setRules({ ...rules, perTx: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rules-day">
              Per day
            </label>
            <input id="rules-day" className="input" inputMode="decimal" value={rules.perDay} onChange={(e) => setRules({ ...rules, perDay: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rules-end">
            Until
          </label>
          <input
            id="rules-end"
            className="input"
            type="date"
            value={rules.expiresAt ? rules.expiresAt.slice(0, 10) : ""}
            onChange={(e) => setRules({ ...rules, expiresAt: e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : null })}
          />
          <span className="field-hint">After this day the self can do nothing until you set new rules. Empty: no end.</span>
        </div>
      </Band>
      <Band label="Recipients" hint="Who the self may pay.">
        {rules.recipients.map((r, i) => (
          <div key={i} className="rules-row">
            <span className="rules-cell" data-label="Address">
              <input aria-label={`Recipient ${i + 1} address`} className="input mono" value={r.address} placeholder="0x..." onChange={(e) => setAt("recipients", i, { ...r, address: e.target.value })} spellCheck={false} />
            </span>
            <span className="rules-cell" data-label="Who">
              <input aria-label={`Recipient ${i + 1} label`} className="input" value={r.label} placeholder="Who" onChange={(e) => setAt("recipients", i, { ...r, label: e.target.value })} />
            </span>
            <button type="button" className="button button-small button-ghost" onClick={() => drop("recipients", i)}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="button button-small" onClick={() => setRules({ ...rules, recipients: [...rules.recipients, emptyRecipient()] })}>
          Add a recipient
        </button>
      </Band>
      <Band label="Contracts" hint="Contracts the self may call, and which of their functions, like order(uint256).">
        {rules.contracts.map((c, i) => (
          <div key={i} className="rules-row rules-row-wide">
            <span className="rules-cell" data-label="Address">
              <input aria-label={`Contract ${i + 1} address`} className="input mono" value={c.address} placeholder="0x..." onChange={(e) => setAt("contracts", i, { ...c, address: e.target.value })} spellCheck={false} />
            </span>
            <span className="rules-cell" data-label="What it is">
              <input aria-label={`Contract ${i + 1} label`} className="input" value={c.label} placeholder="What it is" onChange={(e) => setAt("contracts", i, { ...c, label: e.target.value })} />
            </span>
            <span className="rules-cell" data-label="Functions">
              <input aria-label={`Contract ${i + 1} functions`} className="input mono" value={fns[i] ?? ""} placeholder="order(uint256), cancel()" onChange={(e) => setFns(fns.map((f, j) => (j === i ? e.target.value : f)))} spellCheck={false} />
            </span>
            <button type="button" className="button button-small button-ghost" onClick={() => drop("contracts", i)}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            setRules({ ...rules, contracts: [...rules.contracts, emptyContract()] });
            setFns([...fns, ""]);
          }}
        >
          Add a contract
        </button>
      </Band>
      <Band label="Tokens" hint="Tokens the self may send or approve, each with its own caps, only to recipients above. Moves the wallet cannot cap are always refused.">
        {rules.tokens.map((t, i) => (
          <div key={i} className="rules-row rules-row-wide">
            <span className="rules-cell" data-label="Address">
              <input aria-label={`Token ${i + 1} address`} className="input mono" value={t.address} placeholder="0x..." onChange={(e) => setAt("tokens", i, { ...t, address: e.target.value })} spellCheck={false} />
            </span>
            <span className="rules-cell" data-label="Name">
              <input aria-label={`Token ${i + 1} label`} className="input" value={t.label} placeholder="Name" onChange={(e) => setAt("tokens", i, { ...t, label: e.target.value })} />
            </span>
            <span className="rules-cell" data-label="Decimals">
              <input aria-label={`Token ${i + 1} decimals`} className="input" inputMode="numeric" value={String(t.decimals)} onChange={(e) => setAt("tokens", i, { ...t, decimals: Number(e.target.value) || 0 })} />
            </span>
            <span className="rules-cell" data-label="Per payment">
              <input aria-label={`Token ${i + 1} per payment`} className="input" inputMode="decimal" value={t.perTx} onChange={(e) => setAt("tokens", i, { ...t, perTx: e.target.value })} />
            </span>
            <span className="rules-cell" data-label="Per day">
              <input aria-label={`Token ${i + 1} per day`} className="input" inputMode="decimal" value={t.perDay} onChange={(e) => setAt("tokens", i, { ...t, perDay: e.target.value })} />
            </span>
            <button type="button" className="button button-small button-ghost" onClick={() => drop("tokens", i)}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="button button-small" onClick={() => setRules({ ...rules, tokens: [...rules.tokens, emptyToken()] })}>
          Add a token
        </button>
      </Band>
      <Band label="Try a payment" hint="Checked here against this draft, the same way the wallet checks.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="try-to">
              To
            </label>
            <input id="try-to" className="input mono" value={trial.target} placeholder="0x..." onChange={(e) => setTrial({ ...trial, target: e.target.value })} spellCheck={false} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="try-value">
              Amount
            </label>
            <input id="try-value" className="input" inputMode="decimal" value={trial.value} onChange={(e) => setTrial({ ...trial, value: e.target.value })} />
          </div>
        </div>
        {trialResult ? (
          <p className="small rules-trial" data-ok={trialOk ? "true" : "false"} data-testid="rules-trial">
            {trialResult}
          </p>
        ) : null}
      </Band>
      {problem ? <Notice kind="error">{problem}</Notice> : fingerprint ? <p className="small faint">Fingerprint of this draft: <code className="mono">{fingerprint.slice(0, 18)}...</code></p> : null}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !!problem}>
          {busy ? "Saving" : "Save the rules"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- on chain

function ChainSection({ chain }: { chain: idOps.ChainConfig | null }) {
  const { vault, data } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [state, setState] = useState<idOps.WalletState | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const wallet = data.identityChoices.wallet;
  const owner = data.identityChoices.owner;

  const eth = () => (typeof window !== "undefined" ? (window as unknown as { ethereum?: idOps.InjectedWallet }).ethereum : undefined);
  const act = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const r = await fn();
      if (r) setNote(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (!chain) {
    return (
      <section className="subpanel plate identity-chain" aria-labelledby="chain-title">
        <PlateHead number="04" id="chain-title" title="On chain" lead="Registering the self and setting its wallet's rules, from your own wallet.">
          <span className="plate-state" data-on="false">
            Not configured
          </span>
        </PlateHead>
        <Quiet>
          Nothing here needs a chain until this site sets the registry&apos;s address. The contracts are in the repository (SigilSelfRegistry and SigilSelfWallet) with a script to
          deploy them; the wallet is deployed for your own address and the self key above.
        </Quiet>
      </section>
    );
  }

  return (
    <section className="subpanel plate identity-chain" aria-labelledby="chain-title">
      <PlateHead number="04" id="chain-title" title="On chain" lead={`Chain ${chain.chainId}, registry ${chain.registry.slice(0, 10)}... Each call is sent by your own wallet in this browser; the self key only signs.`} />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={!!busy || !data.identity || !owner || !eth()}
          onClick={() =>
            void act("register", async () => {
              const w = eth()!;
              const data_ = await idOps.registerCalldata(vault, chain, owner, idOps.metadataUrl(origin, data.identity!.address));
              return `Sent: ${await idOps.sendFromOwner(w, chain, chain.registry, data_)}`;
            })
          }
        >
          {busy === "register" ? "Waiting for your wallet" : "Register the self"}
        </button>
        <button
          type="button"
          className="button"
          disabled={!!busy || !wallet || !data.walletRules || !eth()}
          onClick={() => void act("configure", async () => `Sent: ${await idOps.sendFromOwner(eth()!, chain, wallet, idOps.configureCalldata(data.walletRules!))}`)}
        >
          {busy === "configure" ? "Waiting for your wallet" : "Set these rules on the wallet"}
        </button>
        <button type="button" className="button button-danger" disabled={!!busy || !wallet || !eth()} onClick={() => void act("freeze", async () => `Sent: ${await idOps.sendFromOwner(eth()!, chain, wallet, idOps.freezeCalldata())}`)}>
          Freeze the wallet now
        </button>
      </div>
      {!owner || !wallet ? <p className="small faint">Add your own address and the self&apos;s wallet to the statement above to use these.</p> : null}
      {wallet && chain.rpcUrl ? (
        <>
          <button type="button" className="button button-small" disabled={!!busy} onClick={() => void act("read", async () => setState(await idOps.readWallet(chain, wallet)))}>
            {busy === "read" ? "Reading" : "Read the wallet"}
          </button>
          {state ? (
            <div className="wallet-state">
              <dl className="identity-facts">
                <div>
                  <dt>State</dt>
                  <dd>{state.frozen ? "Frozen" : "Active"}</dd>
                </div>
                <div>
                  <dt>Per payment</dt>
                  <dd>{formatUnits(state.perTxCap)}</dd>
                </div>
                <div>
                  <dt>Per day</dt>
                  <dd>{formatUnits(state.perDayCap)}</dd>
                </div>
                <div>
                  <dt>Left today</dt>
                  <dd>{formatUnits(state.remainingToday)}</dd>
                </div>
              </dl>
              {state.spends.length ? (
                <ul className="list">
                  {state.spends.map((s) => (
                    <li key={`${s.tx}-${s.nonce}`} className="list-row">
                      <div className="list-row-main">
                        <p className="list-row-title mono">
                          {s.tokenTo ? `${s.tokenAmount} to ${s.tokenTo}` : `${formatUnits(s.value)} to ${s.target}`}
                        </p>
                        <p className="list-row-meta">
                          Call {s.nonce}
                          {s.selector ? `, function ${s.selector}` : ""}, block {s.block}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Quiet>No spends in the recent blocks.</Quiet>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
