"use client";

import { useEffect, useMemo, useState } from "react";
import { createModelCaller, LEGACY_PERIODS, parseVaultCode, randomId, vaultFingerprint, type LegacyKept, type LegacyPersonPlan, type SelfAnswer } from "@sigil/core";
import { CheckIcon, HourglassIcon, KeyIcon, PlusIcon, ShieldIcon } from "@/components/icons";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import * as legacy from "../legacyOps";
import { errorText, useVault } from "../context";
import { CopyButton, Empty, Fingerprint, Notice, Spinner } from "../ui";

const PERIOD_LABEL: Record<number, string> = { 90: "3 months", 180: "6 months", 365: "12 months" };
const periodLabel = (days: number) => PERIOD_LABEL[days] ?? `${days} days`;

const STAGE: Record<number, string> = {
  0: "All well",
  1: "First warning",
  2: "Last warning",
  3: "Open for release",
};

const STEP_TEXT: Record<number, string> = {
  1: "the first warning",
  2: "the last warning",
  3: "the end of the period, and the plan could be released",
};

function originOf(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** The fragment of /vault/legacy#invite=..., read once and then removed from the address bar. */
function useInviteFragment(): string | null {
  const [fragment] = useState(() => (typeof window !== "undefined" && window.location.hash.startsWith("#invite=") ? window.location.hash : null));
  useEffect(() => {
    if (fragment) window.history.replaceState(null, "", "#legacy");
  }, [fragment]);
  return fragment;
}

export function LegacyTab() {
  const invite = useInviteFragment();
  return (
    <div className="legacy">
      <div className="panel-header">
        <h2 className="panel-title">Legacy</h2>
        <p className="small muted">The people who receive your vault if you stop using it, and the plans that name you.</p>
      </div>
      {invite ? <InviteCard fragment={invite} /> : null}
      <OwnerPlan />
      <TrustedSection />
    </div>
  );
}

// ---------------------------------------------------------------- the owner's plan

interface DraftPerson extends LegacyPersonPlan {
  /** Set for a person added by vault code in this edit, so its fingerprint can be shown. */
  code?: string;
}

function OwnerPlan() {
  const { api, vault, data, update } = useVault();
  const state = data.legacy;
  const record = state.record;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const setLegacy = (next: legacy.LegacyState) => update((d) => ({ ...d, legacy: next }));

  if (state.plan && !record) return <Notice kind="error">Your legacy plan could not be opened with your vault key.</Notice>;

  if (editing || !state.plan) {
    return (
      <PlanEditor
        onCancel={state.plan ? () => setEditing(false) : undefined}
        onSaved={(next, text) => {
          setLegacy(next);
          setEditing(false);
          setMessage(text);
        }}
        message={message}
      />
    );
  }

  const plan = state.plan;
  const people = record!.people;
  const answered = people.filter((p) => !p.publicKey && state.answers[p.id]);
  const waiting = people.filter((p) => !p.publicKey && !state.answers[p.id]);
  const complete = plan.people.some((p) => p.sealed);

  return (
    <section className="legacy-plan" aria-labelledby="legacy-plan-title" data-stage={plan.stage}>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}

      {plan.missed ? (
        <div className="notice legacy-missed" role="status">
          <div>
            <p>
              While you were away your plan reached {STEP_TEXT[plan.missed.stage] ?? "a warning"}
              {plan.missed.at ? ` on ${formatDate(plan.missed.at)}` : ""}. Opening your vault counted as a check-in, so the plan is closed again.
            </p>
            {plan.releasedAt ? (
              <p>
                It was released on {formatDate(plan.releasedAt)}. Those who opened their share may have kept a copy of what they received. To make every share from then
                useless, seal the plan again with a new legacy key.
              </p>
            ) : null}
            <div className="row">
              {plan.releasedAt ? (
                <button
                  type="button"
                  className="button button-small button-primary"
                  disabled={!!busy}
                  onClick={() =>
                    void act("reseal", async () => {
                      const next = await legacy.resealLegacy(api, vault, data);
                      await legacy.dismissMissed(api);
                      if (next?.plan) setLegacy({ ...next, plan: { ...next.plan, missed: null } });
                      setMessage("Sealed again with a new legacy key. The old shares no longer fit.");
                    })
                  }
                >
                  {busy === "reseal" ? "Sealing" : "Seal again with a new key"}
                </button>
              ) : null}
              <button
                type="button"
                className="button button-small button-ghost"
                onClick={() =>
                  void act("dismiss", async () => {
                    await legacy.dismissMissed(api);
                    setLegacy({ ...state, plan: { ...plan, missed: null } });
                  })
                }
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="legacy-heartbeat">
        <div className="legacy-heartbeat-main">
          <span className="legacy-heartbeat-mark" aria-hidden="true">
            <HourglassIcon />
          </span>
          <div>
            <p className="eyebrow">Next check-in due</p>
            <p className="legacy-due" data-testid="legacy-due">
              {formatDate(plan.dueAt)}
            </p>
            <p className="small muted">
              Any sign-in or vault action counts. Last one {state.lastActiveAt ? formatDateTime(state.lastActiveAt) : "not recorded yet"}.
            </p>
          </div>
        </div>
        <ol className="legacy-stages" aria-label="What happens if you stay away">
          <li data-done={plan.stage >= 1 ? "true" : "false"}>
            <span className="legacy-stage-name">First warning</span>
            <span className="legacy-stage-date">{formatDate(plan.firstWarningAt)}</span>
          </li>
          <li data-done={plan.stage >= 2 ? "true" : "false"}>
            <span className="legacy-stage-name">Last warning</span>
            <span className="legacy-stage-date">{formatDate(plan.lastWarningAt)}</span>
          </li>
          <li data-done={plan.stage >= 3 ? "true" : "false"}>
            <span className="legacy-stage-name">Open for release</span>
            <span className="legacy-stage-date">{formatDate(plan.dueAt)}</span>
          </li>
        </ol>
        <div className="row">
          <span className="badge badge-strong">{STAGE[plan.stage]}</span>
          <button
            type="button"
            className="button button-small button-primary"
            disabled={!!busy}
            onClick={() =>
              void act("checkin", async () => {
                setLegacy(await legacy.checkIn(api, vault));
                setMessage("Checked in. The next check-in moved on by the whole period.");
              })
            }
          >
            {busy === "checkin" ? "Checking in" : "Check in now"}
          </button>
        </div>
        <p className="small faint legacy-channel">
          Warnings are written to your read log and shown here when you come back. Sigil has no email or other channel to reach you, so choose a period you will not
          miss.
        </p>
      </div>

      <div className="legacy-summary">
        <div className="panel-header">
          <h3 id="legacy-plan-title" className="settings-heading">
            Your plan
          </h3>
          <div className="row">
            <button type="button" className="button button-small" onClick={() => setEditing(true)}>
              Change
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setCancelling(true)}>
              Cancel the plan
            </button>
          </div>
        </div>
        <p className="small muted">
          {complete ? (
            <>
              Any {plan.threshold} of {plural(people.filter((p) => p.publicKey).length, "trusted person", "trusted people")} together can open what you left them after{" "}
              {periodLabel(plan.periodDays)} without a sign of you. Sealed {formatDateTime(plan.updatedAt)}, key number {plan.epoch}.
            </>
          ) : (
            <>Shares are made once {plan.threshold} people can receive one. Until then nothing can be released.</>
          )}
        </p>
        {cancelling ? (
          <div className="subpanel">
            <p className="small">Cancel the plan? Every share and bundle is deleted from the server at once, and the people you named are no longer told about it.</p>
            <div className="row">
              <button
                type="button"
                className="button button-small button-danger"
                disabled={!!busy}
                onClick={() =>
                  void act("cancel", async () => {
                    await legacy.cancelLegacy(api);
                    setLegacy({ lastActiveAt: state.lastActiveAt, plan: null, record: null, answers: {}, unreadable: false });
                    setCancelling(false);
                  })
                }
              >
                {busy === "cancel" ? "Cancelling" : "Cancel the plan"}
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setCancelling(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : null}

        <ul className="list legacy-people">
          {people.map((p) => {
            const server = plan.people.find((x) => x.id === p.id);
            const asked = plan.requests.find((r) => r.personId === p.id);
            return (
              <li key={p.id} className="list-row legacy-person" data-state={p.publicKey ? (server?.sealed ? "sealed" : "named") : "invited"}>
                <div className="list-row-main">
                  <p className="list-row-title">
                    <KeyIcon /> {p.label}
                    <span className="badge">{p.publicKey ? (server?.sealed ? "Holds a share" : "Named") : state.answers[p.id] ? "Answered the invite" : "Invite sent"}</span>
                  </p>
                  <p className="list-row-meta">
                    {p.folderIds.length ? `Receives ${data.folders.filter((f) => p.folderIds.includes(f.id)).map((f) => f.name).join(", ") || "folders that were deleted"}.` : "No folders."}
                    {p.self ? " May talk to your AI self." : ""}
                    {asked ? ` Asked for a release ${formatDateTime(asked.at)}.` : ""}
                    {server?.openedAt ? ` Opened their share ${formatDateTime(server.openedAt)}.` : ""}
                  </p>
                  {p.publicKey ? <Fingerprint value={vaultFingerprint(p.publicKey)} className="small" /> : null}
                  {!p.publicKey && !state.answers[p.id] ? <InviteLinkRow person={p} /> : null}
                </div>
              </li>
            );
          })}
        </ul>

        {answered.map((p) => {
          const a = state.answers[p.id];
          return (
            <div key={p.id} className="subpanel legacy-answer" data-verified={a.verified ? "true" : "false"}>
              {a.verified ? (
                <>
                  <p className="small">
                    <strong>{p.label}</strong> opened your invite with their vault. Ask them to read out their vault fingerprint and compare:
                  </p>
                  <Fingerprint value={vaultFingerprint(a.publicKey)} />
                  <button
                    type="button"
                    className="button button-small button-primary"
                    disabled={!!busy}
                    onClick={() =>
                      void act("seal-" + p.id, async () => {
                        const next = await legacy.saveLegacy(api, vault, data, {
                          owner: record!.owner,
                          periodDays: record!.periodDays,
                          threshold: record!.threshold,
                          includeModel: record!.includeModel,
                          people: people.map((x) => (x.id === p.id ? { ...x, publicKey: a.publicKey } : x)),
                        });
                        setLegacy(next);
                        setMessage(`${p.label} is in the plan. Everyone received a new share.`);
                      })
                    }
                  >
                    {busy === "seal-" + p.id ? "Sealing" : "It matches: seal their share"}
                  </button>
                </>
              ) : (
                <Notice kind="error">An answer to {p.label}&apos;s invite was not made with the secret in your link, so it was not used. Send them a new invite.</Notice>
              )}
            </div>
          );
        })}
        {waiting.length ? <p className="small faint">Invite links work until the person opens them with their vault. Send each link only to that person.</p> : null}
        <button
          type="button"
          className="button button-small"
          disabled={!!busy}
          onClick={() =>
            void act("again", async () => {
              const next = await legacy.resealLegacy(api, vault, data);
              if (next) setLegacy(next);
              setMessage("Sealed again with the folders and AI self rules as they are now. Everyone received a new share.");
            })
          }
        >
          {busy === "again" ? "Sealing" : "Seal again with what is in the vault now"}
        </button>
      </div>
    </section>
  );
}

function InviteLinkRow({ person }: { person: LegacyPersonPlan }) {
  const link = legacy.inviteLink(originOf(), person);
  if (!link) return null;
  return (
    <div className="legacy-invite-link">
      <code className="mono small" data-testid="legacy-invite-link">
        {link}
      </code>
      <CopyButton text={link} label="Copy invite link" />
    </div>
  );
}

function PlanEditor({ onCancel, onSaved, message }: { onCancel?: () => void; onSaved(next: legacy.LegacyState, text: string): void; message: string | null }) {
  const { api, vault, data } = useVault();
  const record = data.legacy.record;
  const [owner, setOwner] = useState(record?.owner ?? "");
  const [periodDays, setPeriodDays] = useState(record?.periodDays ?? 180);
  const [threshold, setThreshold] = useState(record?.threshold ?? 1);
  const [includeModel, setIncludeModel] = useState(record?.includeModel ?? false);
  const [people, setPeople] = useState<DraftPerson[]>(record?.people ?? []);
  const [adding, setAdding] = useState<"code" | "invite" | null>(record ? null : "code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = data.folders.filter((f) => f.kind !== "agent");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await legacy.saveLegacy(api, vault, data, { owner, periodDays, threshold, includeModel, people });
      const invites = people.filter((p) => !p.publicKey).length;
      onSaved(next, invites ? `Sealed. Send each invite link below to its person; their share is sealed once they open it and you compare fingerprints.` : "Sealed. Each person you named can see that they are named, and nothing more.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const setPerson = (id: string, change: Partial<DraftPerson>) => setPeople((ps) => ps.map((p) => (p.id === id ? { ...p, ...change } : p)));
  const maxThreshold = Math.max(1, people.length);

  return (
    <form className="legacy-editor" onSubmit={save} aria-label="Legacy plan">
      {message ? <Notice kind="success">{message}</Notice> : null}
      {!record ? (
        <div className="legacy-intro">
          <span className="legacy-intro-mark" aria-hidden="true">
            <ShieldIcon />
          </span>
          <div>
            <p className="legacy-intro-title">Your AI self can outlive you</p>
            <p className="small muted">
              Name the people who should receive your vault, the folders each one gets, and whether they may talk to your AI self. If you show no sign of life for the
              period you choose, they can open it together. Your browser splits a legacy key into shares and seals each one to that person&apos;s vault, so Sigil never
              holds a share.
            </p>
          </div>
        </div>
      ) : null}

      <div className="legacy-editor-grid">
        <div className="field">
          <label className="field-label" htmlFor="legacy-owner">
            Your name, as they will see it
          </label>
          <input id="legacy-owner" className="input" value={owner} maxLength={80} onChange={(e) => setOwner(e.target.value)} placeholder="For example Sam" required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="legacy-period">
            Release after this long without a sign of you
          </label>
          <select id="legacy-period" className="select" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))}>
            {LEGACY_PERIODS.map((d) => (
              <option key={d} value={d}>
                {periodLabel(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="legacy-threshold">
            People needed to open it
          </label>
          <select id="legacy-threshold" className="select" value={Math.min(threshold, maxThreshold)} onChange={(e) => setThreshold(Number(e.target.value))}>
            {Array.from({ length: maxThreshold }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {people.length || 1}
              </option>
            ))}
          </select>
          <p className="field-hint">With more than one, no single person can open anything alone.</p>
        </div>
      </div>

      <h3 className="settings-heading">Trusted people</h3>
      {people.length === 0 ? <p className="small muted">Nobody yet. Add someone by their vault code, or send them an invite link.</p> : null}
      <ul className="legacy-person-list">
        {people.map((p) => (
          <li key={p.id} className="legacy-person-card subpanel">
            <div className="legacy-person-head">
              <div className="field">
                <label className="field-label" htmlFor={`lp-name-${p.id}`}>
                  What you call them
                </label>
                <input id={`lp-name-${p.id}`} className="input" value={p.label} maxLength={80} onChange={(e) => setPerson(p.id, { label: e.target.value })} />
              </div>
              <button type="button" className="button button-small button-ghost" onClick={() => setPeople((ps) => ps.filter((x) => x.id !== p.id))}>
                Remove
              </button>
            </div>
            <p className="small faint">
              {p.publicKey ? (
                <>
                  Vault fingerprint <Fingerprint value={vaultFingerprint(p.publicKey)} />
                </>
              ) : (
                "Added by invite link. Their share is sealed once they open the link and you compare fingerprints."
              )}
            </p>
            <fieldset className="field">
              <legend className="field-label">Folders they receive</legend>
              <div className="checkbox-list">
                {folders.map((f) => (
                  <label key={f.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={p.folderIds.includes(f.id)}
                      onChange={(e) => setPerson(p.id, { folderIds: e.target.checked ? [...p.folderIds, f.id] : p.folderIds.filter((x) => x !== f.id) })}
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="checkbox suggest-toggle">
              <input type="checkbox" checked={p.self} onChange={(e) => setPerson(p.id, { self: e.target.checked })} />
              <span>
                May talk to your AI self
                <span className="field-hint">In legacy mode it follows your rules and reads only the folders this person receives.</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {adding ? <AddPerson kind={adding} folders={folders.map((f) => f.id)} existing={people} onAdd={(p) => setPeople((ps) => [...ps, p])} onClose={() => setAdding(null)} /> : null}
      <div className="row">
        <button type="button" className="button button-small" onClick={() => setAdding("code")} disabled={people.length >= 12}>
          <PlusIcon /> Add by vault code
        </button>
        <button type="button" className="button button-small" onClick={() => setAdding("invite")} disabled={people.length >= 12}>
          <PlusIcon /> Add by invite link
        </button>
      </div>

      {data.model ? (
        <label className="checkbox suggest-toggle">
          <input type="checkbox" checked={includeModel} onChange={(e) => setIncludeModel(e.target.checked)} />
          <span>
            Leave my model key to those who may talk to my AI self
            <span className="field-hint">Otherwise they use a model key of their own. Either way the key is inside their sealed bundle.</span>
          </span>
        </label>
      ) : null}

      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || people.length === 0 || !owner.trim()}>
          {busy ? "Sealing" : record ? "Seal the changed plan" : "Seal the plan"}
        </button>
        {onCancel ? (
          <button type="button" className="button button-ghost" onClick={onCancel}>
            Keep the plan as it is
          </button>
        ) : null}
      </div>
      <p className="small faint">Every time the plan is sealed it gets a new legacy key, so shares from before stop fitting.</p>
    </form>
  );
}

function AddPerson({ kind, folders, existing, onAdd, onClose }: { kind: "code" | "invite"; folders: string[]; existing: DraftPerson[]; onAdd(p: DraftPerson): void; onClose(): void }) {
  const { data } = useVault();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  let key: string | null = null;
  let codeError: string | null = null;
  if (kind === "code" && code.trim()) {
    try {
      key = parseVaultCode(code);
      if (key === data.boxPublic) codeError = "That is the code of this vault. Use the other person's vault code.";
      else if (existing.some((p) => p.publicKey === key)) codeError = "That vault is already in the plan.";
    } catch (err) {
      codeError = errorText(err);
    }
  }
  const ready = label.trim() && (kind === "invite" || (key && !codeError));
  return (
    <div className="subpanel legacy-add" data-kind={kind}>
      <p className="small">
        {kind === "code"
          ? "Ask them for their vault code (Folders, Your vault code) and type it here. Then compare the fingerprint with them."
          : "An invite link is made when you seal the plan. Send it only to this person; it works once."}
      </p>
      <div className="field">
        <label className="field-label" htmlFor="legacy-add-label">
          What you call them
        </label>
        <input id="legacy-add-label" className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="For example Ana" />
      </div>
      {kind === "code" ? (
        <div className="field">
          <label className="field-label" htmlFor="legacy-add-code">
            Their vault code
          </label>
          <input id="legacy-add-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sigil_vault..." autoComplete="off" spellCheck={false} />
          {codeError ? <p className="field-hint">{codeError}</p> : key ? <p className="field-hint">Fingerprint to compare: <Fingerprint value={vaultFingerprint(key)} /></p> : null}
        </div>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="button button-small button-primary"
          disabled={!ready}
          onClick={() => {
            onAdd(kind === "code" ? { id: randomId(), label: label.trim(), publicKey: key, invite: null, folderIds: folders.slice(0, 1), self: false } : legacy.newInvitePerson(label, folders.slice(0, 1), false));
            onClose();
          }}
        >
          <CheckIcon /> Add {label.trim() || "them"}
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- invites, from the invited side

function InviteCard({ fragment }: { fragment: string }) {
  const { api, data } = useVault();
  const [invite, setInvite] = useState<legacy.InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"open" | "busy" | "done">("open");

  useEffect(() => {
    let alive = true;
    legacy
      .readInvite(api, fragment)
      .then((i) => alive && setInvite(i))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, fragment]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!invite) return <Spinner label="Opening the invite" />;
  return (
    <section className="legacy-invite subpanel" aria-label="Legacy invite" data-state={invite.answered || state === "done" ? "done" : "open"}>
      <p className="eyebrow">An invite</p>
      <p className="legacy-invite-title">
        {invite.owner} named you, as {invite.label}, as a trusted person in their legacy plan.
      </p>
      <p className="small muted">
        Accepting sends your vault&apos;s public key, tagged with the secret in the link, so {invite.owner}&apos;s vault can tell it came from you. Read your fingerprint out
        to them when they ask:
      </p>
      {data.boxPublic ? <Fingerprint value={vaultFingerprint(data.boxPublic)} /> : null}
      {invite.answered || state === "done" ? (
        <Notice kind="success">Accepted. Once {invite.owner} compares fingerprints and seals your share, the plan shows up below.</Notice>
      ) : (
        <button
          type="button"
          className="button button-primary"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            try {
              await legacy.acceptInvite(api, data, invite);
              setState("done");
            } catch (err) {
              setError(errorText(err));
              setState("open");
            }
          }}
        >
          {state === "busy" ? "Accepting" : "Accept"}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- plans that name this vault

function TrustedSection() {
  const { data } = useVault();
  return (
    <section className="legacy-trusted" aria-labelledby="legacy-trusted-title">
      <h3 id="legacy-trusted-title" className="settings-heading">
        Plans that name you
      </h3>
      {data.trusted.length === 0 ? (
        <Empty icon={<KeyIcon />} title="No plan names you yet">
          When someone names this vault in their legacy plan, it shows up here: who they are, what they would leave you, and how many people are needed to open it.
        </Empty>
      ) : (
        <ul className="legacy-trusted-list">
          {data.trusted.map((t) => (
            <TrustedPlan key={t.planId} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TrustedPlan({ t }: { t: legacy.TrustedView }) {
  const { api, vault, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const note = t.note;
  const names = useMemo(() => new Map((t.mine?.payload.trustees ?? []).map((p) => [p.id, p.label])), [t.mine]);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  if (!note) return <li className="legacy-trusted-plan subpanel">A plan that names you could not be opened with your vault key.</li>;
  const iAsked = t.requests.some((r) => r.personId === t.personId);
  const othersAsking = t.requests.filter((r) => r.personId !== t.personId && !t.passedTo.includes(r.personId));
  const inHand = legacy.sharesInHand(t);
  const need = t.mine?.payload.threshold ?? note.threshold;

  return (
    <li className="legacy-trusted-plan subpanel" data-state={t.kept ? "opened" : t.state}>
      <p className="legacy-trusted-title">
        <strong>{note.owner}</strong> named you as {note.label}
      </p>
      <p className="small muted">
        You would receive {note.folders.length ? note.folders.join(", ") : "no folders"}
        {note.self ? ", and you may talk to their AI self" : ""}. It takes {note.threshold} of {note.total} people, after {periodLabel(note.periodDays)} without a sign of{" "}
        {note.owner}.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {t.kept ? (
        opened ? (
          <LegacyViewer kept={t.kept} owner={note.owner} />
        ) : (
          <button type="button" className="button button-primary" onClick={() => setOpened(true)}>
            Open what {note.owner} left you
          </button>
        )
      ) : t.state === "incomplete" ? (
        <p className="small faint">The plan waits for others to accept their invites. Nothing can be released yet.</p>
      ) : t.state === "waiting" ? (
        <p className="small faint">Nothing can be opened while {note.owner} is active. If that changes, you can ask for a release here.</p>
      ) : (
        <div className="legacy-release" data-testid="legacy-release">
          <ol className="legacy-release-steps">
            <li data-done={iAsked ? "true" : "false"}>
              <span>Ask for a release. The others see that you asked, and {note.owner}&apos;s log records it.</span>
              {!iAsked ? (
                <button type="button" className="button button-small" disabled={!!busy} onClick={() => void act("ask", () => legacy.requestRelease(api, t.planId))}>
                  {busy === "ask" ? "Asking" : "Ask for a release"}
                </button>
              ) : null}
            </li>
            <li data-done={othersAsking.length === 0 && t.passedTo.length > 0 ? "true" : "false"}>
              <span>
                Pass your share to those who asked. It is sealed to the key {note.owner} named for them.
                {othersAsking.length ? ` Waiting for it: ${othersAsking.map((r) => names.get(r.personId) ?? "someone").join(", ")}.` : t.passedTo.length ? " Passed." : " Nobody else has asked yet."}
              </span>
              {othersAsking.length ? (
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!busy}
                  onClick={() =>
                    void act("pass", async () => {
                      await legacy.passToRequesters(api, t);
                    })
                  }
                >
                  {busy === "pass" ? "Passing" : "Pass my share"}
                </button>
              ) : null}
            </li>
            <li data-done={inHand >= need ? "true" : "false"}>
              <span>
                Combine the shares in this browser and open your bundle: {inHand} of {need} in hand.
              </span>
              <button
                type="button"
                className="button button-small button-primary"
                disabled={!!busy || inHand < need || !data.box}
                onClick={() =>
                  void act("open", async () => {
                    await legacy.openRelease(api, vault, data.box!, t);
                    setOpened(true);
                  })
                }
              >
                {busy === "open" ? "Opening" : "Combine and open"}
              </button>
            </li>
          </ol>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- what was left

interface Turn {
  question: string;
  answer: SelfAnswer | null;
  error?: string;
}

function LegacyViewer({ kept, owner }: { kept: LegacyKept; owner: string }) {
  const { api, data } = useVault();
  const [vault, setVault] = useState<legacy.ReleasedVault | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let alive = true;
    legacy
      .loadReleased(api, kept.bundle)
      .then((v) => alive && setVault(v))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, kept]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!vault) return <Spinner label={`Opening what ${owner} left you`} />;
  const self = kept.bundle.self;
  const settings = self?.model ?? data.model;
  const names = new Map(vault.folders.map((f) => [f.id, f.name]));

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || !settings) return;
    const q = question.trim();
    setQuestion("");
    setAsking(true);
    setTurns((ts) => [...ts, { question: q, answer: null }]);
    try {
      const history = turns.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer!.text }));
      const answer = await legacy.askLegacySelf(api, kept.bundle, vault, createModelCaller(settings), q, history);
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, answer } : t)));
    } catch (err) {
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, error: errorText(err) } : t)));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="legacy-viewer" data-testid="legacy-viewer">
      <p className="small muted">
        Read only. {plural(vault.memories.length, "memory", "memories")} in {vault.folders.map((f) => f.name).join(", ") || "no folder"}. Each opening is in {owner}&apos;s read
        log.
      </p>
      <ul className="list legacy-memories">
        {vault.memories.map((m) => (
          <li key={m.id} className="list-row">
            <div className="list-row-main">
              <button type="button" className="text-button list-row-title" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}>
                {m.title}
              </button>
              <p className="list-row-meta">
                {names.get(m.folderId)}, {formatDate(m.editedAt)}
              </p>
              {open === m.id ? <p className="legacy-memory-body">{m.body}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {self ? (
        <div className="legacy-self self-chat" data-mode="legacy">
          <p className="eyebrow">Legacy mode</p>
          <h4 className="legacy-self-title">Talk to {self.rules.name}</h4>
          <p className="small muted">
            An AI that answers as {owner} would have, from these folders only and within the rules {owner} wrote. It does not know anything that happened after. Every
            question and answer is sealed into {owner}&apos;s read log.
          </p>
          {!settings ? <Notice>{owner} did not leave a model key. Add your own under AI self to talk here.</Notice> : null}
          <ol className="chat">
            {turns.map((t, i) => (
              <li key={i} className="chat-turn" data-status={t.answer ? "answered" : t.error ? "failed" : "waiting"}>
                <p className="chat-question">{t.question}</p>
                <p className="chat-answer">{t.answer ? t.answer.text : t.error ? t.error : "Thinking"}</p>
              </li>
            ))}
          </ol>
          <form className="chat-form" onSubmit={ask}>
            <label className="visually-hidden" htmlFor="legacy-question">
              Your question
            </label>
            <input id="legacy-question" className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`Ask ${owner}'s AI self`} disabled={!settings} />
            <button type="submit" className="button button-primary" disabled={asking || !question.trim() || !settings}>
              {asking ? "Asking" : "Ask"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
