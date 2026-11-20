"use client";

// Shared memory: a family's or a team's history, kept together by its members.
// Stories with a date, the people in them and a photo, everyone's entries
// marked with who added them, heirs who become members when a member's legacy
// plan releases, and a readable copy of the whole history to keep or print.

import { useMemo, useState } from "react";
import { peopleOf, timeline, whenLabel, parseVaultCode, vaultFingerprint, type SpaceRole } from "@sigil/core";
import { CameraIcon, DownloadIcon, PersonIcon, StoryIcon, TeamIcon } from "@/components/icons";
import { formatDate, plural } from "@/lib/format";
import * as agents from "../agentOps";
import * as memory from "../memoryOps";
import { shrinkPhoto } from "../deviceOps";
import { errorText, useVault } from "../context";
import { Band, Empty, Fingerprint, Notice, PlateHead, Quiet } from "../ui";
import type { SpaceView } from "../agentOps";

function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SharedTab() {
  const { data } = useVault();
  const spaces = memory.memorySpaces(data);
  const [current, setCurrent] = useState<string | null>(spaces[0]?.id ?? null);
  const [making, setMaking] = useState(spaces.length === 0);
  const space = spaces.find((s) => s.id === current) ?? spaces[0] ?? null;
  return (
    <div className="shared">
      <div className="panel-header">
        <h2 className="panel-title">Shared memory</h2>
        <p className="small muted">
          A family&apos;s or a team&apos;s history, kept by its members together: stories with their dates, the people in them and photos, each marked with who added it. It
          is encrypted with a key only its members hold. What someone wrote stays when they leave, and heirs you name become members when a member&apos;s legacy plan releases.
        </p>
      </div>
      {spaces.length > 1 ? (
        <div className="segmented shared-pick" role="group" aria-label="Shared memories">
          {spaces.map((s) => (
            <button key={s.id} type="button" aria-pressed={s.id === space?.id} onClick={() => setCurrent(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {making ? <NewSpace onDone={(id) => (setMaking(false), id && setCurrent(id))} canCancel={spaces.length > 0} /> : null}
      {space ? <SpaceBody key={space.id} space={space} /> : !making ? <Empty icon={<TeamIcon />} title="No shared memory yet" /> : null}
      {!making ? (
        <div className="form-actions">
          <button type="button" className="button" onClick={() => setMaking(true)}>
            Start another shared memory
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewSpace({ onDone, canCancel }: { onDone(id: string | null): void; canCancel: boolean }) {
  const { api, data, reload } = useVault();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"family" | "history">("family");
  const [about, setAbout] = useState("");
  const [myName, setMyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="subpanel plate shared-new"
      aria-label="New shared memory"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const id = await memory.createMemorySpace(api, data, { name: name || (kind === "family" ? "Our family" : "Our history"), kind, about, myName: myName || "Me" });
          await reload();
          onDone(id);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlateHead number="01" id="shared-new" title="Start a shared memory" lead="You are its first admin. Add the others by their vault codes once it exists." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="It">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="shared-name">
              Name
            </label>
            <input id="shared-name" className="input" value={name} maxLength={120} placeholder="Our family" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="shared-kind">
              Kind
            </label>
            <select id="shared-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as "family" | "history")}>
              <option value="family">Family</option>
              <option value="history">Team history</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="shared-about">
            A line about it <span className="faint">(optional)</span>
          </label>
          <input id="shared-about" className="input" value={about} maxLength={400} onChange={(e) => setAbout(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="shared-me">
            Your name in it
          </label>
          <input id="shared-me" className="input" value={myName} maxLength={80} onChange={(e) => setMyName(e.target.value)} />
        </div>
      </Band>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Sealing" : "Start it"}
        </button>
        {canCancel ? (
          <button type="button" className="button button-ghost" onClick={() => onDone(null)}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function SpaceBody({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [error, setError] = useState<string | null>(null);
  if (!space.me.acceptedAt) {
    return (
      <section className="subpanel plate" aria-label={space.name}>
        <PlateHead number="01" title={space.name} lead={space.about || "A member added you."} />
        {error ? <Notice kind="error">{error}</Notice> : null}
        <button
          type="button"
          className="button button-primary"
          onClick={async () => {
            try {
              await agents.acceptSpace(api, space.id);
              await reload();
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          Accept and open it
        </button>
      </section>
    );
  }
  return (
    <>
      <TimelineSection space={space} />
      {space.me.role !== "read" ? <StoryForm space={space} /> : null}
      <PeopleSection space={space} />
      <MembersSection space={space} />
      <KeepSection space={space} />
    </>
  );
}

function TimelineSection({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [error, setError] = useState<string | null>(null);
  const people = useMemo(() => new Map(peopleOf(space.memories).map((p) => [p.id, p.name])), [space.memories]);
  const names = useMemo(() => new Map(space.members.map((m) => [m.id, m.label])), [space.members]);
  const years = timeline(space.memories);
  return (
    <section className="subpanel plate shared-timeline" aria-labelledby={`timeline-${space.id}`}>
      <PlateHead number="01" id={`timeline-${space.id}`} title={space.name} lead={space.about || "The stories, oldest first."}>
        <span className="plate-state" data-on="true">
          {space.kind === "family" ? "Family" : "Team history"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {years.length === 0 ? (
        <Quiet>No stories yet.</Quiet>
      ) : (
        <ol className="history" data-testid="history">
          {years.map((y) => (
            <li key={y.year} className="history-year">
              <h4 className="history-year-label">{y.year}</h4>
              <ul className="history-stories">
                {y.stories.map((s) => (
                  <li key={s.id} className="history-story" data-testid="story">
                    <p className="history-story-title">
                      <StoryIcon /> {s.title}
                    </p>
                    <p className="history-story-meta small faint">
                      {s.when ? whenLabel(s.when) : `Written down ${formatDate(s.createdAt)}`}
                      {(s.people ?? []).length ? ` · With ${(s.people ?? []).map((id) => people.get(id)).filter(Boolean).join(", ")}` : ""}
                      {s.author ? ` · Added by ${names.get(s.author) ?? "a former member"}` : ""}
                    </p>
                    {s.image ? (
                      <figure className="memory-photo history-photo">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a photo decrypted on this device, as a data: address */}
                        <img src={`data:${s.image.type};base64,${s.image.data}`} alt={s.title} />
                      </figure>
                    ) : null}
                    {s.body ? <p className="history-story-body">{s.body}</p> : null}
                    {s.author === space.me.id || space.me.role === "admin" ? (
                      <button
                        type="button"
                        className="text-button small"
                        onClick={async () => {
                          try {
                            await agents.deleteSpaceMemory(api, space.id, s.id);
                            await reload();
                          } catch (err) {
                            setError(errorText(err));
                          }
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function StoryForm({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [photo, setPhoto] = useState<{ type: "image/jpeg"; data: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = peopleOf(space.memories);
  return (
    <form
      className="subpanel plate shared-story"
      aria-label="Add a story"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await memory.addStory(api, space, { title, text, when, people: [...people], image: photo });
          setTitle("");
          setText("");
          setWhen("");
          setPeople(new Set());
          setPhoto(null);
          await reload();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlateHead number="02" title="Add a story" lead="Encrypted on this device with the space's key, and marked as added by you." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="The story">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="story-title">
              Title
            </label>
            <input id="story-title" className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="story-when">
              When
            </label>
            <input id="story-when" className="input" value={when} placeholder="1962, 1962-07 or 1962-07-14" onChange={(e) => setWhen(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="story-text">
            What happened
          </label>
          <textarea id="story-text" className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {known.length ? (
          <fieldset className="checkbox-list">
            <legend className="field-label">Who is in it</legend>
            {known.map((p) => (
              <label key={p.id} className="checkbox" htmlFor={`story-p-${p.id}`}>
                <input
                  id={`story-p-${p.id}`}
                  type="checkbox"
                  checked={people.has(p.id)}
                  onChange={(e) => {
                    const next = new Set(people);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    setPeople(next);
                  }}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="capture-photo">
          {photo ? (
            <figure className="memory-photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- the photo, made smaller on this device */}
              <img src={`data:${photo.type};base64,${photo.data}`} alt="The photo for this story" />
              <button type="button" className="text-button small" onClick={() => setPhoto(null)}>
                Remove the photo
              </button>
            </figure>
          ) : (
            <label className="button capture-photo-button" htmlFor={`story-photo-${space.id}`}>
              <CameraIcon /> Add a photo
            </label>
          )}
          <input
            id={`story-photo-${space.id}`}
            className="visually-hidden"
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) shrinkPhoto(f).then(setPhoto).catch(() => setError("That photo could not be read on this device."));
            }}
          />
        </div>
      </Band>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || (!title.trim() && !text.trim() && !photo)}>
          {busy ? "Sealing" : "Add the story"}
        </button>
      </div>
    </form>
  );
}

function PeopleSection({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [about, setAbout] = useState("");
  const [member, setMember] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = peopleOf(space.memories);
  const canWrite = space.me.role !== "read";
  return (
    <section className="subpanel plate shared-people" aria-labelledby={`people-${space.id}`}>
      <PlateHead number="03" id={`people-${space.id}`} title="People" lead="Members and anyone else the stories are about, with a name only." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {people.length === 0 ? (
        <Quiet>No people named yet.</Quiet>
      ) : (
        <ul className="list shared-people-list">
          {people.map((p) => (
            <li key={p.id} className="list-row">
              <div className="list-row-main">
                <p className="list-row-title">
                  <PersonIcon /> {p.name} {p.relation ? <span className="faint">{p.relation}</span> : null}
                  {p.member ? <span className="badge">A member</span> : null}
                </p>
                {p.about ? <p className="list-row-meta">{p.about}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form
          className="shared-person-form"
          aria-label="Add a person"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await memory.addPerson(api, space, { name, relation, about, member: member || null });
              setName("");
              setRelation("");
              setAbout("");
              setMember("");
              await reload();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="rules-row rules-row-wide">
            <input aria-label="Person's name" className="input" value={name} placeholder="Name" maxLength={120} onChange={(e) => setName(e.target.value)} />
            <input aria-label="Relation" className="input" value={relation} placeholder="Relation" maxLength={48} onChange={(e) => setRelation(e.target.value)} />
            <select aria-label="Is a member" className="select" value={member} onChange={(e) => setMember(e.target.value)}>
              <option value="">Not a member</option>
              {space.members
                .filter((m) => m.kind === "vault")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
            <button type="submit" className="button button-small" disabled={busy || !name.trim()}>
              Add
            </button>
          </div>
          <input aria-label="About them" className="input" value={about} placeholder="A line about them (optional)" maxLength={4000} onChange={(e) => setAbout(e.target.value)} />
        </form>
      ) : null}
    </section>
  );
}

function MembersSection({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<SpaceRole>("write");
  const [heirCode, setHeirCode] = useState("");
  const [heirLabel, setHeirLabel] = useState("");
  const [heirRole, setHeirRole] = useState<"read" | "write">("read");
  const [heirFor, setHeirFor] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = space.me.role === "admin";
  const vaults = space.members.filter((m) => m.kind === "vault");
  const fingerprint = (c: string) => {
    try {
      return vaultFingerprint(parseVaultCode(c));
    } catch {
      return null;
    }
  };
  const act = async (name: string, fn: () => Promise<unknown>) => {
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
  return (
    <section className="subpanel plate shared-members" aria-labelledby={`members-${space.id}`}>
      <PlateHead number="04" id={`members-${space.id}`} title="Members and heirs" lead="Roles as in a team space: read, write (and change or delete their own entries), admin." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="list">
        {vaults.map((m) => (
          <li key={m.id} className="list-row" data-testid="shared-member">
            <div className="list-row-main">
              <p className="list-row-title">
                {m.label} <span className="badge">{m.role}</span>
                {m.id === space.me.id ? <span className="badge badge-strong">You</span> : null}
                {!m.acceptedAt ? <span className="faint"> Not accepted yet</span> : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {admin ? (
        <form
          className="shared-member-form"
          aria-label="Add a member"
          onSubmit={(e) => {
            e.preventDefault();
            void act("member", () => agents.addVaultMember(api, space, code, label, role).then(() => (setCode(""), setLabel(""))));
          }}
        >
          <Band label="Add a member" hint="By their vault code, which they find under Folders.">
            <div className="field">
              <label className="field-label" htmlFor={`member-code-${space.id}`}>
                Their vault code
              </label>
              <input id={`member-code-${space.id}`} className="input mono" value={code} onChange={(e) => setCode(e.target.value)} />
              {fingerprint(code) ? <Fingerprint value={fingerprint(code)!} /> : null}
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label" htmlFor={`member-label-${space.id}`}>
                  Their name in it
                </label>
                <input id={`member-label-${space.id}`} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`member-role-${space.id}`}>
                  Role
                </label>
                <select id={`member-role-${space.id}`} className="select" value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <button type="submit" className="button button-small" disabled={!!busy || !fingerprint(code)}>
              {busy === "member" ? "Sealing" : "Add the member"}
            </button>
          </Band>
        </form>
      ) : null}

      <h4 className="settings-heading">Heirs</h4>
      {space.heirs.length === 0 ? (
        <Quiet>No heirs named. An heir becomes a member when the legacy plan of the member they are named for releases.</Quiet>
      ) : (
        <ul className="list" data-testid="heir-list">
          {space.heirs.map((h) => (
            <li key={h.id} className="list-row" data-testid="heir">
              <div className="list-row-main">
                <p className="list-row-title">
                  {h.label} <span className="badge">{h.role}</span>
                  {!h.trusted ? <span className="badge">Not added by a key holder</span> : null}
                </p>
                <p className="list-row-meta">{h.forMember ? `When ${space.members.find((m) => m.id === h.forMember)?.label ?? "a member"}'s legacy plan releases` : "When any member's legacy plan releases"}</p>
              </div>
              {admin ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small button-ghost" disabled={!!busy} onClick={() => void act(`heir-${h.id}`, () => memory.removeHeir(api, space.id, h.id))}>
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {admin ? (
        <form
          className="shared-heir-form"
          aria-label="Name an heir"
          onSubmit={(e) => {
            e.preventDefault();
            void act("heir", () => memory.nameHeir(api, space, { code: heirCode, label: heirLabel, role: heirRole, forMember: heirFor || null }).then(() => (setHeirCode(""), setHeirLabel(""))));
          }}
        >
          <Band label="Name an heir" hint="Their key is sealed now, and only used when the plan releases. Leaving or a member's death never deletes what others wrote.">
            <div className="field">
              <label className="field-label" htmlFor={`heir-code-${space.id}`}>
                Heir&apos;s vault code
              </label>
              <input id={`heir-code-${space.id}`} className="input mono" value={heirCode} onChange={(e) => setHeirCode(e.target.value)} />
              {fingerprint(heirCode) ? <Fingerprint value={fingerprint(heirCode)!} /> : null}
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label" htmlFor={`heir-label-${space.id}`}>
                  Heir&apos;s name
                </label>
                <input id={`heir-label-${space.id}`} className="input" value={heirLabel} maxLength={80} onChange={(e) => setHeirLabel(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`heir-role-${space.id}`}>
                  Role then
                </label>
                <select id={`heir-role-${space.id}`} className="select" value={heirRole} onChange={(e) => setHeirRole(e.target.value as "read" | "write")}>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`heir-for-${space.id}`}>
                For
              </label>
              <select id={`heir-for-${space.id}`} className="select" value={heirFor} onChange={(e) => setHeirFor(e.target.value)}>
                <option value="">Any member</option>
                {vaults.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="button button-small" disabled={!!busy || !fingerprint(heirCode)}>
              {busy === "heir" ? "Sealing" : "Name the heir"}
            </button>
          </Band>
        </form>
      ) : null}
    </section>
  );
}

function KeepSection({ space }: { space: SpaceView }) {
  const { api, reload } = useVault();
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const stories = space.memories.filter((m) => m.source.kind !== "person").length;
  const fileName = `${space.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "history"}.html`;
  return (
    <section className="subpanel plate shared-keep" aria-labelledby={`keep-${space.id}`}>
      <PlateHead number="05" id={`keep-${space.id}`} title="Keep a copy" lead="The whole history as one readable document, decrypted on this device. It is also part of your vault's bundle, encrypted, under Storage." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="row">
        <button type="button" className="button" onClick={() => saveText(fileName, memory.historyDocument(space))} data-testid="history-download">
          <DownloadIcon /> Download the history ({plural(stories, "story", "stories")})
        </button>
        <button
          type="button"
          className="button button-ghost"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([memory.historyDocument(space)], { type: "text/html" }));
            window.open(url, "_blank", "noopener");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          Open it to print
        </button>
      </div>
      {leaving ? (
        <div className="subpanel">
          <p className="small">Leave {space.name}? What you wrote stays for the others. You can be added again by an admin.</p>
          <div className="row">
            <button
              type="button"
              className="button button-small button-danger"
              onClick={async () => {
                try {
                  await memory.leaveSpace(api, space.id);
                  await reload();
                } catch (err) {
                  setError(errorText(err));
                  setLeaving(false);
                }
              }}
            >
              Leave
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setLeaving(false)}>
              Stay
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="text-button small" onClick={() => setLeaving(true)}>
          Leave this shared memory
        </button>
      )}
    </section>
  );
}
