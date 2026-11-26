"use client";

import { useEffect, useMemo, useState } from "react";
import {
  checkCall,
  cleanWalletRules,
  EMPTY_RULES,
  formatUnits,
  parseUnits,
  signingFingerprint,
  verifyIdentityStatement,
  walletRulesHash,
  type RulesContract,
  type RulesRecipient,
  type RulesToken,
  type WalletRules,
} from "@sigil/core";
import { IdentityIcon, ImportIcon, WalletIcon } from "@/components/icons";
import { formatDate, formatDateTime } from "@/lib/format";
import * as idOps from "../identityOps";
import * as pay from "../payOps";
import { connectWallet } from "../wallet";
import { errorText, useVault } from "../context";
import { Band, CopyButton, download, Empty, Notice, PlateHead, Quiet } from "../ui";

/** The AI self's identity: its own key, a statement signed by that key and the vault, and the rules of its wallet. */
export function IdentityTab() {
  const { api, data } = useVault();
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
      {/* The address connected and the wallet created on chain below fill the statement's form in again. */}
      <StatementSection key={`${data.identityChoices.owner}-${data.identityChoices.wallet}`} chain={chain ?? null} />
      <RulesSection chain={chain ?? null} />
      <ChainSection chain={chain ?? null} />
      {chain ? <PaySection chain={chain} /> : null}
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

/** A token's caps as the wallet will hold them: whole tokens scaled by the decimals the token answered on chain. */
function baseUnits(t: RulesToken): string | null {
  try {
    return `${parseUnits(t.perTx || "0", t.decimals).toLocaleString("en-US")} and ${parseUnits(t.perDay || "0", t.decimals).toLocaleString("en-US")}`;
  } catch {
    return null;
  }
}

function RulesSection({ chain }: { chain: idOps.ChainConfig | null }) {
  const { api, vault, data, update } = useVault();
  const [rules, setRules] = useState<WalletRules>(data.walletRules ?? EMPTY_RULES);
  const [fns, setFns] = useState<string[]>((data.walletRules?.contracts ?? []).map((c) => c.functions.join(", ")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [trial, setTrial] = useState({ what: "coin", target: "", value: "" });
  const [onChain, setOnChain] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const canReadTokens = !!chain?.rpcUrl;

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
  const trialToken = trial.what === "coin" ? null : (rules.tokens[Number(trial.what)] ?? null);
  if (trial.target.trim() && !problem) {
    const r = trialToken
      ? checkCall(draft(), { target: trialToken.address, value: "0", fn: "transfer(address,uint256)", to: trial.target.trim(), amount: trial.value || "0" })
      : checkCall(draft(), { target: trial.target.trim(), value: trial.value || "0", fn: "" });
    trialOk = r.ok;
    trialResult = r.ok ? "The wallet would let the self send this." : r.reason;
  }

  const canTryOnChain = !!chain?.rpcUrl && !!data.identityChoices.wallet && !!data.identity;
  /** The same payment, asked of the wallet on chain as the self key: its real rules, caps, spending today and balance. */
  const tryOnChain = async () => {
    if (!chain || !data.identity) return;
    setChecking(true);
    setOnChain(null);
    try {
      const call = idOps.paymentCall(trial.target.trim(), trial.value || "0", trialToken ? { address: trialToken.address, decimals: trialToken.decimals } : null);
      const refusal = await idOps.tryOnChain(chain, data.identityChoices.wallet, data.identity.address, call);
      setOnChain(refusal ? { ok: false, text: `On chain: ${refusal}` } : { ok: true, text: "On chain: the wallet would let the self send this now." });
    } catch (err) {
      setOnChain({ ok: false, text: errorText(err) });
    } finally {
      setChecking(false);
    }
  };

  const addToken = async () => {
    if (!chain) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const info = await idOps.readToken(chain, newToken);
      if (rules.tokens.some((t) => t.address.toLowerCase() === info.address.toLowerCase())) throw new Error("That token is already listed.");
      setRules({ ...rules, tokens: [...rules.tokens, { address: info.address, label: info.symbol, decimals: info.decimals, perTx: "0", perDay: "0" }] });
      setNewToken("");
    } catch (err) {
      setTokenError(errorText(err));
    } finally {
      setTokenBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = cleanWalletRules(draft());
      // Every token's decimals are checked against the token itself before the draft is kept.
      if (next.tokens.length && chain?.rpcUrl) await idOps.checkTokenDecimals(chain, next);
      // A recipient must be a person's address, never a contract.
      if (next.recipients.length && chain?.rpcUrl) await idOps.checkRecipientsAreNotContracts(chain, next);
      const clean = await idOps.saveRules(api, vault, next);
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
    if (k === "tokens") setTrial({ ...trial, what: "coin" });
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
      <Band label="Recipients" hint="Who the self may pay, in the chain's coin or in the tokens below. Only these addresses can receive anything from the self.">
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
      <Band
        label="Contracts"
        hint="Contracts the self may call, and which of their functions, like order(uint256). The self never pays a contract directly. A listed function can still send what it is given to any address its arguments name, and routers do: for a self that should only pay the recipients above, list no router. An allowance you give a router from your own wallet for trading can be moved anywhere by the self in one call to that router, and an allowance through Permit2 stays open after a freeze."
      >
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
      <Band
        label="Tokens"
        hint="Tokens the self may send or approve, each with its own caps, only to the recipients above. Each token's decimals are read from the token itself, never typed. Moves the wallet cannot cap are always refused."
      >
        {rules.tokens.map((t, i) => (
          <div key={t.address} className="rules-token">
            <div className="rules-row rules-row-wide">
              <span className="rules-cell" data-label="Address">
                <input aria-label={`Token ${i + 1} address`} className="input mono" value={t.address} readOnly spellCheck={false} />
              </span>
              <span className="rules-cell" data-label="Name">
                <input aria-label={`Token ${i + 1} label`} className="input" value={t.label} placeholder="Name" onChange={(e) => setAt("tokens", i, { ...t, label: e.target.value })} />
              </span>
              <span className="rules-cell" data-label="Decimals">
                <input aria-label={`Token ${i + 1} decimals`} className="input" value={String(t.decimals)} readOnly title="Read from the token on chain" />
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
            {baseUnits(t) ? (
              <p className="small faint rules-base" data-testid={`token-base-${i + 1}`}>
                On chain these caps are {baseUnits(t)} base units ({t.decimals} decimals, as the token answered).
              </p>
            ) : null}
          </div>
        ))}
        {canReadTokens ? (
          <div className="rules-add-token">
            <input aria-label="New token address" className="input mono" value={newToken} placeholder="Token address, 0x..." onChange={(e) => setNewToken(e.target.value)} spellCheck={false} />
            <button type="button" className="button button-small" disabled={tokenBusy || !newToken.trim()} onClick={() => void addToken()}>
              {tokenBusy ? "Reading the token" : "Add a token"}
            </button>
          </div>
        ) : (
          <Quiet>Tokens are added once this site has a read address for the chain: each token&apos;s decimals are read from the token itself, so no cap is ever guessed.</Quiet>
        )}
        {tokenError ? <Notice kind="error">{tokenError}</Notice> : null}
      </Band>
      <Band label="Try a payment" hint={canTryOnChain ? "Checked here against this draft, the same way the wallet checks, and on chain against what the wallet holds now." : "Checked here against this draft, the same way the wallet checks."}>
        <div className={rules.tokens.length ? "grid grid-3" : "grid grid-2"}>
          {rules.tokens.length ? (
            <div className="field">
              <label className="field-label" htmlFor="try-what">
                Pay in
              </label>
              <select id="try-what" className="select" value={trial.what} onChange={(e) => setTrial({ ...trial, what: e.target.value })}>
                <option value="coin">The chain&apos;s coin</option>
                {rules.tokens.map((t, i) => (
                  <option key={t.address} value={String(i)}>
                    {t.label || t.address}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
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
        {canTryOnChain && trial.target.trim() ? (
          <div className="rules-trial-chain">
            <button type="button" className="button button-small" disabled={checking} onClick={() => void tryOnChain()}>
              {checking ? "Asking the chain" : "Check on chain"}
            </button>
            {onChain ? (
              <p className="small rules-trial" data-ok={onChain.ok ? "true" : "false"} data-testid="rules-trial-chain">
                {onChain.text}
              </p>
            ) : null}
          </div>
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

/** A token amount in its own units when the draft knows the token, otherwise in base units. */
function tokenAmount(rules: WalletRules | null, token: string, amount: bigint): string {
  const t = rules?.tokens.find((x) => x.address.toLowerCase() === token.toLowerCase());
  return t ? `${formatUnits(amount, t.decimals)} ${t.label || "tokens"}` : `${amount} base units`;
}

/** The owner's own browser wallet. On a phone without one, this page opens inside the wallet app instead. */
async function ownerWallet(): Promise<idOps.InjectedWallet> {
  return (await connectWallet()).provider;
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function ChainSection({ chain }: { chain: idOps.ChainConfig | null }) {
  const { api, vault, data, update } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [state, setState] = useState<idOps.WalletState | null>(null);
  const [entry, setEntry] = useState<idOps.RegistryEntry | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rows, setRows] = useState<idOps.RuleRow[] | null>(null);
  const [fund, setFund] = useState("");
  const [take, setTake] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const wallet = data.identityChoices.wallet;
  const owner = data.identityChoices.owner;
  const rules = data.walletRules;
  const selfKey = data.identity?.address ?? "";
  const canRead = !!chain?.rpcUrl;

  const refresh = async () => {
    if (!chain || !canRead || !selfKey) return;
    setEntry(await idOps.readRegistry(chain, selfKey));
    if (wallet) setBalance(await idOps.walletBalance(chain, wallet));
  };

  useEffect(() => {
    let alive = true;
    if (!chain || !canRead || !selfKey) return;
    idOps
      .readRegistry(chain, selfKey)
      .then((e) => alive && setEntry(e))
      .catch(() => alive && setEntry(undefined));
    if (wallet)
      idOps
        .walletBalance(chain, wallet)
        .then((b) => alive && setBalance(b))
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [chain, canRead, selfKey, wallet]);

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

  const saveChoice = async (patch: Partial<idOps.IdentityChoices>) => {
    const choices = await idOps.saveChoices(api, vault, { ...data.identityChoices, ...patch });
    update((d) => ({ ...d, identityChoices: choices }));
    return choices;
  };

  /** Sends one transaction from the owner's wallet and waits for it to be in a block. */
  const send = async (to: string | null, payload: `0x${string}`, value = 0n, gas?: bigint) => {
    const eth = await ownerWallet();
    const tx = await idOps.sendFromOwner(eth, chain!, to, payload, value, gas);
    return { tx, receipt: await idOps.waitForTx(chain!, tx, { eth }) };
  };
  // Freeze and revoke always carry gas for all 16 allowances the wallet can list (only the gas used is paid),
  // so no estimate can skip one and none the self adds while you confirm is missed. Then the list is read back.
  const revokeAll = async (payload: `0x${string}`, done: string) => {
    await send(wallet, payload, 0n, idOps.REVOKE_GAS_ALL);
    const left = await idOps.openApprovalCount(chain!, wallet).catch(() => null);
    if (left === null) return `${done} The open allowances could not be read back; read the wallet to check them.`;
    if (left > 0) return `${done} ${left} allowance${left === 1 ? " is" : "s are"} still open: press Set them all to zero.`;
    return `${done} No allowance the self gave is open.`;
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

  const readOlder = async () => {
    if (!state) return;
    const page = await idOps.readSpends(chain, wallet, { toBlock: state.spendsFromBlock - 1, untilTime: null, maxChunks: 9 });
    setState({ ...state, spends: [...state.spends, ...page.spends], spendsFromBlock: page.fromBlock, coversToday: state.coversToday });
  };

  const registered = !!entry && !entry.revokedAt;
  const linked = registered && !!wallet && entry!.wallet?.toLowerCase() === wallet.toLowerCase();
  const stage = registered ? (wallet ? "Wallet ready" : "Registered") : "Not registered";

  return (
    <section className="subpanel plate identity-chain" aria-labelledby="chain-title">
      <PlateHead number="04" id="chain-title" title="On chain" lead={`Chain ${chain.chainId}, registry ${short(chain.registry)}. Every step is sent by your own wallet in this browser; the self key only signs.`}>
        <span className="plate-state" data-on={registered ? "true" : "false"} data-testid="chain-stage">
          {stage}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? (
        <Notice kind="success">
          <span data-testid="chain-note">{note}</span>
        </Notice>
      ) : null}
      {!canRead ? <Notice>This site has no read address for the chain, so the vault cannot check what each step did. Steps can still be sent from your wallet.</Notice> : null}

      <Band label="Your wallet" hint="Your own address registers the self and owns its wallet. It can do anything the self cannot.">
        <div className="chain-step">
          <p className="chain-step-state mono" data-testid="owner-address">
            {owner || "Not connected"}
          </p>
          <button
            type="button"
            className="button button-small"
            disabled={!!busy}
            onClick={() =>
              void act("connect", async () => {
                const eth = await ownerWallet();
                const address = await idOps.ownerAccount(eth, chain);
                await saveChoice({ owner: address });
                return `Connected ${address}.`;
              })
            }
          >
            <WalletIcon /> {busy === "connect" ? "Waiting for your wallet" : owner ? "Use another address" : "Connect your wallet"}
          </button>
        </div>
      </Band>

      <Band label="Registry" hint="The public record that your address stands behind this self key. Its statement above is what the record points to.">
        <div className="chain-step">
          <p className="chain-step-state" data-testid="registry-state">
            {entry === undefined
              ? canRead
                ? "Reading"
                : "Unknown"
              : entry === null
                ? "Not registered"
                : entry.revokedAt
                  ? "Revoked"
                  : `Registered to ${short(entry.owner)}${entry.pendingOwner ? `, handing over to ${short(entry.pendingOwner)}` : ""}`}
          </p>
          <button
            type="button"
            className="button button-small"
            disabled={!!busy || !data.identity || !owner || !data.identity.statement || registered}
            onClick={() =>
              void act("register", async () => {
                const payload = await idOps.registerCalldata(vault, chain, owner, idOps.metadataUrl(origin, selfKey));
                await send(chain.registry, payload);
                await refresh();
                return "The self is registered to your address.";
              })
            }
          >
            {busy === "register" ? "Registering" : "Register the self"}
          </button>
        </div>
        {!data.identity?.statement ? <p className="small faint">Sign the statement above first: the registry points to it.</p> : null}
      </Band>

      <Band label="The self's wallet" hint="A contract only for this self: your address owns it, the self key above may spend from it within the rules.">
        <div className="chain-step">
          <p className="chain-step-state mono" data-testid="self-wallet">
            {wallet ? `${wallet}${balance !== null ? `, holds ${formatUnits(balance)}` : ""}` : "No wallet yet"}
          </p>
          {!wallet ? (
            <button
              type="button"
              className="button button-small"
              disabled={!!busy || !registered || !owner}
              onClick={() =>
                void act("create", async () => {
                  const made = await send(null, idOps.deployWalletData(owner, selfKey));
                  const address = made.receipt.contractAddress;
                  if (!address) throw new Error("The wallet was sent but its address could not be read. Check the transaction in your wallet.");
                  await saveChoice({ wallet: address });
                  await send(chain.registry, idOps.setWalletCalldata(selfKey, address));
                  await refresh();
                  return `The self's wallet is at ${address} and linked in the registry. Sign a new statement above so it names the wallet.`;
                })
              }
            >
              {busy === "create" ? "Creating" : "Create the self's wallet"}
            </button>
          ) : !linked && registered ? (
            <button
              type="button"
              className="button button-small"
              disabled={!!busy}
              onClick={() =>
                void act("link", async () => {
                  await send(chain.registry, idOps.setWalletCalldata(selfKey, wallet));
                  await refresh();
                  return "The wallet is linked in the registry.";
                })
              }
            >
              Link it in the registry
            </button>
          ) : null}
        </div>
        {wallet ? (
          <div className="grid grid-2">
            <div className="chain-amount">
              <label className="field-label" htmlFor="chain-fund">
                Send to the wallet
              </label>
              <div className="chain-amount-row">
                <input id="chain-fund" className="input" inputMode="decimal" value={fund} placeholder="0.01" onChange={(e) => setFund(e.target.value)} />
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!busy || !fund.trim()}
                  onClick={() =>
                    void act("fund", async () => {
                      await send(wallet, "0x", parseUnits(fund));
                      setFund("");
                      await refresh();
                      return `Sent ${fund} to the self's wallet.`;
                    })
                  }
                >
                  {busy === "fund" ? "Sending" : "Send"}
                </button>
              </div>
            </div>
            <div className="chain-amount">
              <label className="field-label" htmlFor="chain-take">
                Take back to your address
              </label>
              <div className="chain-amount-row">
                <input id="chain-take" className="input" inputMode="decimal" value={take} placeholder="0.01" onChange={(e) => setTake(e.target.value)} />
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!busy || !take.trim() || !owner}
                  onClick={() =>
                    void act("take", async () => {
                      await send(wallet, idOps.withdrawCalldata(owner, parseUnits(take)));
                      setTake("");
                      await refresh();
                      return `${take} is back at your address.`;
                    })
                  }
                >
                  {busy === "take" ? "Sending" : "Withdraw"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Band>

      <Band label="Rules on chain" hint="The draft above, set on the wallet by your own wallet. What the chain holds is read back and shown next to the draft.">
        <div className="row">
          <button
            type="button"
            className="button button-small"
            disabled={!!busy || !wallet || !rules}
            onClick={() =>
              void act("configure", async () => {
                // The caps of each token are scaled by its decimals: checked against the token itself right before they are set.
                if (rules!.tokens.length) await idOps.checkTokenDecimals(chain, rules!);
                // An older draft may hold a contract as a recipient: refused here too, before anything is sent.
                if (rules!.recipients.length) await idOps.checkRecipientsAreNotContracts(chain, rules!);
                await send(wallet, idOps.configureCalldata(rules!));
                if (canRead) setRows(await idOps.compareRules(chain, wallet, rules!));
                return "The rules are set on the wallet.";
              })
            }
          >
            {busy === "configure" ? "Setting" : "Set these rules on the wallet"}
          </button>
          <button type="button" className="button button-small button-ghost" disabled={!!busy || !wallet || !rules || !canRead} onClick={() => void act("compare", async () => setRows(await idOps.compareRules(chain, wallet, rules!)))}>
            {busy === "compare" ? "Reading" : "Compare with the chain"}
          </button>
        </div>
        {rows ? (
          <table className="rules-compare" data-testid="rules-compare">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Draft</th>
                <th scope="col">On chain</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.what}-${i}`} data-same={r.same ? "true" : "false"}>
                  <th scope="row">{r.what}</th>
                  <td data-label="Draft">{r.draft}</td>
                  <td data-label="On chain">
                    {r.chain}
                    {r.same ? null : <span className="rules-compare-flag"> Differs</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Band>

      <Band label="Stop" hint="Freezing stops the self at once and sets every allowance it gave back to zero. Only you can unfreeze, and unfreezing cancels any call it signed before.">
        <div className="row">
          <button type="button" className="button button-small button-danger" disabled={!!busy || !wallet} onClick={() => void act("freeze", async () => revokeAll(idOps.freezeCalldata(), "The wallet is frozen."))}>
            {busy === "freeze" ? "Freezing" : "Freeze the wallet now"}
          </button>
          <button type="button" className="button button-small" disabled={!!busy || !wallet} onClick={() => void act("unfreeze", async () => (await send(wallet, idOps.unfreezeCalldata()), "The wallet is active again."))}>
            Unfreeze
          </button>
          <button
            type="button"
            className="button button-small button-ghost"
            disabled={!!busy || !wallet}
            onClick={() => void act("cancel", async () => (await send(wallet, idOps.cancelSignedCalldata()), "Every call the self signed and nobody sent yet is cancelled."))}
          >
            Cancel signed calls
          </button>
        </div>
      </Band>

      {wallet && canRead ? (
        <>
          <button
            type="button"
            className="button button-small"
            disabled={!!busy}
            onClick={() => void act("read", async () => setState(await idOps.readWallet(chain, wallet, { tokens: (rules?.tokens ?? []).map((t) => t.address) })))}
          >
            {busy === "read" ? "Reading" : "Read the wallet"}
          </button>
          {state ? (
            <div className="wallet-state" data-testid="wallet-state">
              <dl className="identity-facts">
                <div>
                  <dt>State</dt>
                  <dd data-testid="wallet-frozen">{state.frozen ? "Frozen" : "Active"}</dd>
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
              {state.tokens.length ? (
                <ul className="list" aria-label="Token caps on chain">
                  {state.tokens.map((t) => (
                    <li key={t.token} className="list-row" data-testid="token-on-chain">
                      <div className="list-row-main">
                        {t.unread ? (
                          <>
                            <p className="list-row-title">Could not read these caps</p>
                            <p className="list-row-meta">The chain did not answer for {t.token}. Read the wallet again before you rely on them.</p>
                          </>
                        ) : (
                          <>
                            <p className="list-row-title">
                              {tokenAmount(rules, t.token, t.perTx)} per payment, {tokenAmount(rules, t.token, t.perDay)} per day
                            </p>
                            <p className="list-row-meta">
                              Set on chain for {t.token}. Left today {tokenAmount(rules, t.token, t.remainingToday)}.
                            </p>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {state.approvals.length || state.approvalsUnread ? (
                <div className="wallet-approvals">
                  <p className="small">
                    {state.approvalsUnread
                      ? "The allowances the self gave could not be read. Read the wallet again, or set them all to zero now."
                      : "Allowances the self gave that may still be open:"}
                  </p>
                  <ul className="list">
                    {state.approvals.map((a) => (
                      <li key={`${a.token}-${a.spender}`} className="list-row">
                        <div className="list-row-main">
                          <p className="list-row-title mono">{a.allowance === null ? "Unknown" : tokenAmount(rules, a.token, a.allowance)}</p>
                          <p className="list-row-meta">
                            To {a.spender}, on {a.token}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="button button-small" disabled={!!busy} onClick={() => void act("revoke", async () => revokeAll(idOps.revokeApprovalsCalldata(), "Set back to zero."))}>
                    Set them all to zero
                  </button>
                </div>
              ) : null}
              <p className="small faint">{state.coversToday ? `Spends since 00:00 UTC today, read back to block ${state.spendsFromBlock}.` : `Spends read back to block ${state.spendsFromBlock}.`}</p>
              {state.spends.length ? (
                <ul className="list" data-testid="wallet-spends">
                  {state.spends.map((s) => (
                    <li key={`${s.tx}-${s.nonce}`} className="list-row">
                      <div className="list-row-main">
                        <p className="list-row-title mono">{s.tokenTo ? `${tokenAmount(rules, s.target, s.tokenAmount)} to ${s.tokenTo}` : `${formatUnits(s.value)} to ${s.target}`}</p>
                        <p className="list-row-meta">
                          Call {s.nonce}
                          {s.selector ? `, function ${s.selector}` : ""}, block {s.block}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Quiet>No spends in the blocks read so far.</Quiet>
              )}
              {state.spendsFromBlock > 0 ? (
                <button type="button" className="button button-small button-ghost" disabled={!!busy} onClick={() => void act("older", readOlder)}>
                  {busy === "older" ? "Reading" : "Read further back"}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- payments by the self

function PaySection({ chain }: { chain: idOps.ChainConfig }) {
  const { api, vault, data, update } = useVault();
  const rules = data.walletRules;
  const wallet = data.identityChoices.wallet;
  const [ask, setAsk] = useState({ to: "", token: "", amount: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<pay.PaymentOutcome | null>(null);
  if (!wallet || !rules || !data.identity) return null;
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const out = await pay.selfPay(api, vault, data, ownerWallet, chain, wallet, data.identity!.address, { to: ask.to, amount: ask.amount, token: ask.token || null });
      if (out.kind === "queued") update((d) => ({ ...d, drafts: [out.draft, ...d.drafts] }));
      setOutcome(out);
      setAsk({ ...ask, amount: "" });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="subpanel plate identity-pay" onSubmit={run} aria-label="Ask the self to pay">
      <PlateHead
        number="05"
        id="pay-title"
        title="Payments by the self"
        lead="Ask your self to pay a recipient. Within the limits you set under Limits and the wallet's caps on chain, the self key signs the payment and your wallet sends it, with a receipt. Past a limit, it waits in Work for you."
      >
        <span className="plate-state" data-on={data.limits.payments.on ? "true" : "false"}>
          {data.limits.payments.on ? "On its own within limits" : "Every payment waits for you"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {outcome?.kind === "paid" ? (
        <Notice kind="success">
          <span data-testid="pay-outcome">Paid on its own, under: {outcome.limit}. Its receipt is under Limits.</span>
        </Notice>
      ) : null}
      {outcome?.kind === "queued" ? (
        <Notice>
          <span data-testid="pay-outcome">Waiting for you in Work: {outcome.reason}</span>
        </Notice>
      ) : null}
      {rules.recipients.length === 0 ? (
        <Quiet>Add a recipient to the wallet rules first, and set them on the wallet.</Quiet>
      ) : (
        <>
          <div className="grid grid-3">
            <div className="field">
              <label className="field-label" htmlFor="pay-to">
                To
              </label>
              <select id="pay-to" className="select" value={ask.to} onChange={(e) => setAsk({ ...ask, to: e.target.value })} required>
                <option value="">Choose a recipient</option>
                {rules.recipients.map((r) => (
                  <option key={r.address} value={r.address}>
                    {r.label || r.address}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pay-in">
                Pay in
              </label>
              <select id="pay-in" className="select" value={ask.token} onChange={(e) => setAsk({ ...ask, token: e.target.value })}>
                <option value="">The chain&apos;s coin</option>
                {rules.tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.label || t.address}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pay-amount">
                Amount
              </label>
              <input id="pay-amount" className="input" inputMode="decimal" value={ask.amount} onChange={(e) => setAsk({ ...ask, amount: e.target.value })} required />
            </div>
          </div>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy || !ask.to || !ask.amount.trim()}>
              {busy ? "Asking" : "Ask the self to pay"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
