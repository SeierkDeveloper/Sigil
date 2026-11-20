"use client";

import { useEffect, useState } from "react";
import { cleanHandle, cleanRules, DEFAULT_RULES, isHandle, PUBLIC_MAX_PER_VISITOR, splitList } from "@sigil/core";
import { formatDateTime } from "@/lib/format";
import * as pub from "../publicOps";
import { errorText, useVault } from "../context";
import { Band, CopyButton, Notice, PlateHead, Quiet } from "../ui";

/** The public AI self: a page at /@handle that answers anyone, only from folders you made public. */
export function PublicSelfSection() {
  const { api, vault, data, update } = useVault();
  const self = data.publicSelf;
  const [editing, setEditing] = useState(!self);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  // Questions arrive while the vault is open; the counts and the wall follow.
  useEffect(() => {
    if (!self) return;
    let alive = true;
    const t = window.setInterval(() => {
      api
        .get<{ self: pub.ServerPublicSelf | null }>("public/self")
        .then((r) => pub.openPublicSelf(vault, r.self))
        .then((r) => alive && update((d) => ({ ...d, publicSelf: r.self })))
        .catch(() => undefined);
    }, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, vault, self?.id, update]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate self-public" aria-labelledby="self-public" data-testid="public-self">
      <PlateHead
        number="06"
        id="self-public"
        title="Public AI self"
        lead={
          <>
            A page anyone can open and ask. It answers only from the folders you make public: those are published as a separate public copy, masked with each
            folder&apos;s rules, and nothing else is ever given to it. Protected folders can never be made public. Every answer is marked as AI, with the public notes
            it came from.
          </>
        }
      >
        {self ? (
          <span className="plate-state" data-on={self.enabled ? "true" : "false"}>
            {self.enabled ? (self.online ? "Online" : "On, offline") : "Off"}
          </span>
        ) : null}
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {self && !editing ? (
        <>
          <p className="app-key mono" data-testid="public-url">
            {pub.publicUrl(origin, self.handle)}
          </p>
          <div className="row public-address-actions">
            <CopyButton text={pub.publicUrl(origin, self.handle)} label="Copy address" />
            <a className="button button-small button-ghost" href={`/@${self.handle}`} target="_blank" rel="noreferrer">
              Open the page
            </a>
            <button type="button" className="button button-small" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
          <dl className="public-facts">
            <div>
              <dt>{self.items === 1 ? "Public note" : "Public notes"}</dt>
              <dd>{self.items}</dd>
            </div>
            <div>
              <dt>Asked</dt>
              <dd>{self.asked}</dd>
            </div>
            <div>
              <dt>Answered</dt>
              <dd>{self.answered}</dd>
            </div>
          </dl>
          <p className="small muted public-facts-note">
            {self.publishedAt ? `Published ${formatDateTime(self.publishedAt)}, kept` : "Kept"} up to date while this vault is open.{" "}
            {self.appId ? "Answered by your connector while it runs with --self." : "Answered by this vault while it is open."} Each question and answer is in your read log.
          </p>
          <Wall />
          {confirmOff ? (
            <div className="subpanel">
              <p className="small">Turn it off for good? The page, the public copy, the questions waiting and the wall are deleted. Your vault and your log stay.</p>
              <div className="row">
                <button
                  type="button"
                  className="button button-danger button-small"
                  disabled={busy === "off"}
                  onClick={() =>
                    void act("off", async () => {
                      await pub.turnOffPublic(api);
                      update((d) => ({ ...d, publicSelf: null }));
                      setConfirmOff(false);
                      setEditing(true);
                    })
                  }
                >
                  Delete the public AI self
                </button>
                <button type="button" className="button button-ghost button-small" onClick={() => setConfirmOff(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <p className="public-end">
              <button type="button" className="text-button small" onClick={() => setConfirmOff(true)}>
                Delete it for good
              </button>
            </p>
          )}
        </>
      ) : (
        <PublicForm
          onCancel={self ? () => setEditing(false) : undefined}
          onSave={async (input) => {
            const view = await pub.savePublic(api, vault, data, input);
            update((d) => ({ ...d, publicSelf: view }));
            setEditing(false);
          }}
        />
      )}
    </section>
  );
}

function Wall() {
  const { api, data, update } = useVault();
  const self = data.publicSelf!;
  const [busy, setBusy] = useState<string | null>(null);
  if (!self.showAnswers && self.wall.length === 0) return <Quiet>Answered questions are not shown on the page. Turn it on under Change.</Quiet>;
  if (self.wall.length === 0) return <Quiet>No answered questions on the page yet.</Quiet>;
  return (
    <ul className="list public-wall-list" aria-label="Answers on the page">
      {self.wall.map((w) => (
        <li key={w.id} className="list-row" data-hidden={w.hidden ? "true" : "false"} data-testid="wall-row">
          <div className="list-row-main">
            <p className="list-row-title">{w.question}</p>
            <p className="list-row-meta">{w.answer}</p>
          </div>
          <div className="list-row-actions">
            <span className="badge wall-state" data-hidden={w.hidden ? "true" : "false"}>
              {w.hidden ? "Hidden" : "Shown"}
            </span>
            <button
              type="button"
              className="button button-small button-ghost"
              disabled={busy === w.id}
              onClick={async () => {
                setBusy(w.id);
                try {
                  await pub.hideWallAnswer(api, w.id, !w.hidden);
                  update((d) => (d.publicSelf ? { ...d, publicSelf: { ...d.publicSelf, wall: d.publicSelf.wall.map((x) => (x.id === w.id ? { ...x, hidden: !w.hidden } : x)) } } : d));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {w.hidden ? "Show" : "Hide"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PublicForm({ onCancel, onSave }: { onCancel?: () => void; onSave(input: pub.PublicInput): Promise<void> }) {
  const { data } = useVault();
  const cur = data.publicSelf;
  const base = cur?.secret?.rules ?? data.self ?? DEFAULT_RULES;
  const [handle, setHandle] = useState(cur?.handle ?? "");
  const [name, setName] = useState(cur?.name ?? data.self?.name ?? DEFAULT_RULES.name);
  const [greeting, setGreeting] = useState(cur?.greeting ?? "");
  const [tone, setTone] = useState(base.tone);
  const [deny, setDeny] = useState(base.denyTopics.join(", "));
  const [neverSay, setNeverSay] = useState(base.neverSay.join(", "));
  const [folders, setFolders] = useState<Set<string>>(new Set(cur?.secret?.folderIds ?? []));
  const [perHour, setPerHour] = useState(cur?.perVisitorHour ?? 10);
  const [showAnswers, setShowAnswers] = useState(cur?.showAnswers ?? false);
  const [enabled, setEnabled] = useState(cur?.enabled ?? true);
  const [voice, setVoice] = useState(cur?.voice ?? false);
  const [by, setBy] = useState(cur?.appId ?? "vault");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerers = data.apps.filter((a) => !a.revokedAt && a.kind !== "extension" && a.kind !== "web" && !data.agents.some((x) => x.appId === a.id));
  const clean = cleanHandle(handle);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!isHandle(clean)) throw new Error("A handle is 3 to 30 lowercase letters, digits, - or _, and not a word Sigil uses itself.");
      if (!data.model) throw new Error("Add your model key above first: your public AI self answers with it.");
      await onSave({
        handle: clean,
        name,
        greeting,
        rules: cleanRules({ ...base, name, tone, denyTopics: splitList(deny), neverSay: splitList(neverSay), allowTopics: [] }),
        folderIds: [...folders],
        perVisitorHour: perHour,
        showAnswers,
        enabled,
        appId: by === "vault" ? null : by,
        voice,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel new-link" onSubmit={submit} aria-label="Public AI self">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="The page" hint="Its address and what visitors see first.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="public-handle">
              Handle
            </label>
            <input id="public-handle" className="input mono" value={handle} maxLength={31} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" autoComplete="off" spellCheck={false} required />
            <span className="field-hint">The page is at /@{clean || "yourname"}.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="public-name">
              Name it uses
            </label>
            <input id="public-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="public-greeting">
            Greeting
          </label>
          <input id="public-greeting" className="input" value={greeting} maxLength={400} onChange={(e) => setGreeting(e.target.value)} placeholder="Ask me about my work." />
        </div>
      </Band>
      <Band label="What is public" hint="Only these folders, as a public copy. Everything else stays encrypted and out of reach.">
        <fieldset className="checkbox-list">
          <legend className="visually-hidden">Folders to make public</legend>
          {data.folders.map((f) => (
            <label key={f.id} className="checkbox" htmlFor={`public-folder-${f.id}`}>
              <input
                id={`public-folder-${f.id}`}
                type="checkbox"
                disabled={!!f.protect}
                checked={folders.has(f.id) && !f.protect}
                onChange={(e) => {
                  const next = new Set(folders);
                  if (e.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  setFolders(next);
                }}
              />
              <span>
                {f.name}
                {f.protect ? " (protected, cannot be public)" : f.redact?.length ? " (masked)" : ""}
              </span>
            </label>
          ))}
        </fieldset>
      </Band>
      <Band label="How it answers" hint="Its own rules, apart from your private AI self's.">
        <div className="field">
          <label className="field-label" htmlFor="public-tone">
            Tone
          </label>
          <input id="public-tone" className="input" value={tone} maxLength={600} onChange={(e) => setTone(e.target.value)} />
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="public-deny">
              Topics it never talks about
            </label>
            <input id="public-deny" className="input" value={deny} onChange={(e) => setDeny(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="public-never">
              Things it must never say
            </label>
            <input id="public-never" className="input" value={neverSay} onChange={(e) => setNeverSay(e.target.value)} />
          </div>
        </div>
      </Band>
      <Band label="Limits" hint="Per visitor, counted without keeping their address.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="public-hour">
              Questions an hour, per visitor
            </label>
            <input id="public-hour" className="input" type="number" min={1} max={PUBLIC_MAX_PER_VISITOR} value={perHour} onChange={(e) => setPerHour(Math.min(PUBLIC_MAX_PER_VISITOR, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="public-by">
              Answered by
            </label>
            <select id="public-by" className="select" value={by} onChange={(e) => setBy(e.target.value)}>
              <option value="vault">This vault, while it is open</option>
              {answerers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}, through its connector
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="checkbox" htmlFor="public-wall">
          <input id="public-wall" type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} />
          <span>
            Show answered questions on the page
            <span className="field-hint">You can hide any of them. Off: questions and answers are only in your log.</span>
          </span>
        </label>
        <label className="checkbox" htmlFor="public-voice">
          <input id="public-voice" type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
          <span>
            Offer voice on the page
            <span className="field-hint">Visitors can speak their question and hear the answer. The speech model runs in their own browser, loaded only if they turn it on.</span>
          </span>
        </label>
        <label className="checkbox" htmlFor="public-on">
          <input id="public-on" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>On: the page takes questions</span>
        </label>
      </Band>
      <div className="form-actions plate-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Publishing" : "Save and publish"}
        </button>
        {onCancel ? (
          <button type="button" className="button button-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
