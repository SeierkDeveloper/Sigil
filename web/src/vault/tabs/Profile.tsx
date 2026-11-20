"use client";

import { useMemo, useState } from "react";
import { parseProfileBody, PROFILE_HEADINGS, PROFILE_LIMIT, type ProfileSections } from "@sigil/core";
import { CardIcon, LockIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { AppMark } from "../marks";
import { Notice } from "../ui";

const HINTS: Record<keyof ProfileSections, string> = {
  who: "Your work, where you are in life, what you care about. Only what you want apps to know.",
  answers: "Length, tone, language, format. For example: short answers, plain words, metric units.",
  projects: "What you are working on now, so apps can keep it in mind.",
};

/** The Self card: a short profile apps read first, kept in its own folder so it is granted like any folder. */
export function ProfileTab() {
  const { api, vault, data, update, goTo } = useVault();
  const card = useMemo(() => ops.profileMemory(data), [data]);
  const folder = ops.profileFolder(data);
  const initial = useMemo(() => (card ? parseProfileBody(card.body) : { who: "", answers: "", projects: "" }), [card]);
  const [sections, setSections] = useState<ProfileSections>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const readerApps = folder ? data.apps.filter((a) => !a.revokedAt && a.folderIds.includes(folder.id)) : [];
  const readers = readerApps.map((a) => a.name);
  const fingerprint = ops.vaultCode(data)?.fingerprint ?? null;
  const dirty = (Object.keys(sections) as (keyof ProfileSections)[]).some((k) => sections[k] !== initial[k]);
  const empty = (Object.values(sections) as string[]).every((v) => !v.trim());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await ops.saveProfile(api, vault, data, sections);
      update((d) => ({
        ...d,
        folders: r.createdFolder ? [...d.folders, r.folder] : d.folders,
        memories: [r.memory, ...d.memories.filter((m) => m.id !== r.memory.id)],
      }));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="profile" onSubmit={save} aria-label="Self card">
      <div className="panel-header">
        <h2 className="panel-title">Self card</h2>
        <p className="small muted">
          A short card about you that connected apps read first, through the get_profile tool. It is encrypted like every memory and lives in its own
          folder, so an app reads it only if you give it that folder.
        </p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">Your Self card is saved.</Notice> : null}

      <div className="self-layout">
        <div className="self-card" data-state={!card ? "new" : dirty ? "changed" : "saved"}>
          <div className="self-card-top">
            <span className="self-card-mark" aria-hidden="true">
              <CardIcon />
            </span>
            <p className="self-card-kind">Self card</p>
            <span className="badge self-card-state">{!card ? "Not saved yet" : dirty ? "Unsaved changes" : "Saved"}</span>
          </div>

          <div className="self-card-fields">
            {(Object.keys(PROFILE_HEADINGS) as (keyof ProfileSections)[]).map((k, i) => (
              <div key={k} className="field self-field" data-part={k}>
                <div className="self-field-head">
                  <span className="self-field-number" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <label className="field-label" htmlFor={`profile-${k}`}>
                    {PROFILE_HEADINGS[k]}
                  </label>
                  <span className="self-field-count" aria-hidden="true">
                    {sections[k].length.toLocaleString("en-US")} / {PROFILE_LIMIT.toLocaleString("en-US")}
                  </span>
                </div>
                <textarea
                  id={`profile-${k}`}
                  className="textarea"
                  rows={4}
                  maxLength={PROFILE_LIMIT}
                  value={sections[k]}
                  onChange={(e) => {
                    setSaved(false);
                    setSections((s) => ({ ...s, [k]: e.target.value }));
                  }}
                />
                <span className="field-hint">{HINTS[k]}</span>
              </div>
            ))}
          </div>

          <div className="self-card-foot">
            {fingerprint ? (
              <p className="self-card-id">
                <span className="self-card-id-label">Vault fingerprint</span>
                <span className="self-card-id-value">{fingerprint}</span>
              </p>
            ) : null}
            <p className="self-card-id self-card-sealed">
              <LockIcon />
              <span>Encrypted on this device</span>
            </p>
          </div>
        </div>

        <aside className="self-aside" aria-label="Who reads your Self card">
          <div className="profile-access subpanel">
            <p className="self-aside-label">Who reads it</p>
            {readerApps.length ? (
              <ul className="self-readers" aria-hidden="true">
                {readerApps.map((a) => (
                  <li key={a.id} className="self-reader">
                    <AppMark kind={a.kind} />
                    <span>{a.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="small">
              {!folder
                ? "Saving makes a folder called Self card. No app can read it until you give it that folder."
                : readers.length
                  ? `Readable by ${readers.join(", ")}.`
                  : "No app can read it yet. Give an app the Self card folder under Apps."}
            </p>
            {folder ? (
              <button type="button" className="button button-small" onClick={() => goTo("apps")}>
                Choose apps
              </button>
            ) : null}
          </div>
          <ul className="self-notes">
            <li>Connected apps are asked to read it first, so they start from who you are.</li>
            <li>It lives in its own folder with its own key. An app without that folder cannot open it.</li>
            <li>Every read of it goes into your read log, like any other memory.</li>
          </ul>
          {card ? <p className="editor-meta">Last saved {formatDateTime(card.editedAt)}.</p> : null}
        </aside>
      </div>

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !dirty || (empty && !card)}>
          {busy ? "Saving" : card ? "Save changes" : "Save Self card"}
        </button>
      </div>
    </form>
  );
}
