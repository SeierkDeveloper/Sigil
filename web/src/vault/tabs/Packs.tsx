"use client";

import { useState } from "react";
import { signingFingerprint } from "@sigil/core";
import { PackIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as packs from "../packOps";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { CopyButton, Empty, Notice, PlateHead, Quiet } from "../ui";

/** Knowledge packs: a folder published as a signed pack others follow, and the packs this vault follows. Free. */
export function PacksTab() {
  return (
    <div className="packs">
      <div className="panel-header">
        <h2 className="panel-title">Knowledge packs</h2>
        <p className="small muted">
          Turn a folder into a pack: a title, a few lines about it and a version, signed by your vault. Anyone with its link can read it and follow it; their vault takes in
          each new version and checks that you signed it. Followed packs land in a folder of their own, which you can give to your AI self or your agents like any folder.
          A pack is public, so publish only what you would put on a public page.
        </p>
      </div>
      <PublishSection />
      <FollowSection />
    </div>
  );
}

function PublishSection() {
  const { api, vault, data, update } = useVault();
  const folders = data.folders.filter((f) => !f.protect && !f.name.startsWith("Pack: "));
  const [folderId, setFolderId] = useState(folders[0]?.id ?? "");
  const have = data.packs.find((p) => p.folderId === folderId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [publisher, setPublisher] = useState(data.identityChoices.name || "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const count = data.memories.filter((m) => m.folderId === folderId).length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("publish");
    setError(null);
    setDone(null);
    try {
      const r = await packs.publish(api, vault, data, { folderId, title: title || have?.title || data.folders.find((f) => f.id === folderId)?.name || "", description, publisher, origin });
      update((d) => ({ ...d, packs: [...d.packs.filter((p) => p.id !== r.row.id), r.row] }));
      setDone(`Version ${r.row.version} is published.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate packs-publish" aria-labelledby="packs-publish-title">
      <PlateHead number="01" id="packs-publish-title" title="Publish a folder" lead="Each memory is masked with the folder's rules first. Protected folders cannot be published.">
        <span className="plate-state" data-on={data.packs.length ? "true" : "false"}>
          {plural(data.packs.length, "pack")}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {done ? <Notice kind="success">{done}</Notice> : null}
      {folders.length === 0 ? (
        <Quiet>No folder can be published: protected folders never are.</Quiet>
      ) : (
        <form onSubmit={submit} aria-label="Publish a folder">
          <div className="field">
            <label className="field-label" htmlFor="pack-folder">
              Folder
            </label>
            <select id="pack-folder" className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <span className="field-hint">{plural(count, "memory", "memories")} in it now.</span>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label" htmlFor="pack-title">
                Title
              </label>
              <input id="pack-title" className="input" value={title} maxLength={120} placeholder={have?.title ?? ""} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pack-publisher">
                Published by
              </label>
              <input id="pack-publisher" className="input" value={publisher} maxLength={80} onChange={(e) => setPublisher(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="pack-description">
              What it is
            </label>
            <textarea id="pack-description" className="textarea" rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!!busy || count === 0}>
              <PackIcon /> {busy === "publish" ? "Signing" : have ? `Publish version ${have.version + 1}` : "Publish as a pack"}
            </button>
          </div>
        </form>
      )}
      {data.packs.length ? (
        <ul className="list">
          {data.packs.map((p) => {
            const url = packs.packUrl(origin, p.id);
            return (
              <li key={p.id} className="list-row" data-testid="pack-row">
                <div className="list-row-main">
                  <p className="list-row-title">
                    <PackIcon /> {p.title} <span className="badge">Version {p.version}</span>
                  </p>
                  <p className="list-row-meta">
                    From {data.folders.find((f) => f.id === p.folderId)?.name ?? "a deleted folder"}. Updated {formatDateTime(p.updatedAt)}.
                  </p>
                  <code className="mono small" data-testid="pack-link">
                    {url}
                  </code>
                </div>
                <div className="list-row-actions">
                  <CopyButton text={url} label="Copy link" />
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(p.id);
                      try {
                        await packs.withdraw(api, p.id);
                        update((d) => ({ ...d, packs: d.packs.filter((x) => x.id !== p.id) }));
                      } catch (err) {
                        setError(errorText(err));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Take down
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function FollowSection() {
  const { api, vault, data, update } = useVault();
  const [link, setLink] = useState(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("follow") ?? "") : ""));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate packs-follow" aria-labelledby="packs-follow-title">
      <PlateHead number="02" id="packs-follow-title" title="Packs you follow" lead="Checked on this device against the publisher you first followed, version by version, each time your vault opens.">
        <span className="plate-state" data-on={data.follows.length ? "true" : "false"}>
          {plural(data.follows.length, "pack")}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      <form
        className="row pack-follow-form"
        aria-label="Follow a pack"
        onSubmit={(e) => {
          e.preventDefault();
          void act("follow", async () => {
            const r = await packs.follow(api, vault, data, packs.packRef(link, origin));
            update((d) => ({ ...d, follows: [...d.follows, r.follow], folders: [...d.folders, r.folder], memories: [...r.memories, ...d.memories] }));
            setLink("");
            setNote(`Following ${r.follow.title}: ${plural(r.memories.length, "memory", "memories")} in the folder ${r.folder.name}.`);
          });
        }}
      >
        <label className="visually-hidden" htmlFor="pack-link-input">
          A pack&apos;s link
        </label>
        <input id="pack-link-input" className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="A pack's link, like .../p/..." spellCheck={false} />
        <button type="submit" className="button" disabled={!!busy || !link.trim()}>
          {busy === "follow" ? "Checking" : "Follow"}
        </button>
      </form>
      {data.follows.length === 0 ? (
        <Empty icon={<PackIcon />} title="Not following any pack">
          Paste a pack&apos;s link above, or press Follow on a pack&apos;s page.
        </Empty>
      ) : (
        <>
          <ul className="list">
            {data.follows.map((f) => (
              <li key={f.id} className="list-row" data-testid="follow-row">
                <div className="list-row-main">
                  <p className="list-row-title">
                    <PackIcon /> {f.title} <span className="badge">Version {f.version}</span>
                  </p>
                  <p className="list-row-meta">
                    In {data.folders.find((x) => x.id === f.folderId)?.name ?? "a deleted folder"}. Publisher key {signingFingerprint(f.publisherKey)}. Updated {formatDateTime(f.updatedAt)}.
                  </p>
                </div>
                <div className="list-row-actions">
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void act(f.id, async () => {
                        const next = await packs.unfollow(api, vault, data, f.id);
                        update((d) => ({ ...d, follows: next }));
                      })
                    }
                  >
                    Unfollow
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button button-small"
            disabled={!!busy}
            onClick={() =>
              void act("refresh", async () => {
                const r = await packs.refresh(api, data, vault);
                if (r.updated.length) {
                  const fresh = await ops.loadVault(api, vault);
                  update(() => fresh);
                }
                setNote(
                  r.updated.length
                    ? r.updated.map((u) => `${u.title}: version ${u.from} to ${u.to}.`).join(" ")
                    : r.failed.length
                      ? `Not taken in: ${r.failed.map((x) => x.reason).join(" ")}`
                      : "Every pack is up to date.",
                );
              })
            }
          >
            {busy === "refresh" ? "Checking" : "Check for new versions"}
          </button>
        </>
      )}
    </section>
  );
}
