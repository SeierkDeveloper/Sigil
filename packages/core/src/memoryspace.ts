// Shared memory: a family's or a team's history, built on team spaces. The
// space key, the roles and the member tags are the same (space.ts); a shared
// memory adds a timeline of stories, the people in them (members and others
// with a name only), photos, and who added what.
//
//   a story    a memory of source "story", with when it happened (a year, a
//              month or a day) and the ids of the people in it
//   a person   a memory of source "person": a name, how they are related, a
//              line about them, and the member they are, if they are one
//
// Both are encrypted with the space key like any memory. The node records
// which member wrote each entry, so the timeline can say who added what.
//
// A shared memory outlives its members. Leaving it, or a member's legacy plan
// releasing, never deletes what others wrote. The space may name heirs: vaults
// that become members when a named member's legacy plan releases (or any
// member's, for an heir named for the whole space). An heir's key and tag are
// made by an admin's device when the heir is named, exactly as for a member,
// and sealed again whenever the space gets a new key; the node keeps them
// dormant and moves them into the member list on release.

import { cleanWhen, type Memory, type MemoryDraft } from "./vault";
import { sealForMember, type SealedMember, type SpaceMember, type SpaceRole } from "./space";

export interface PersonDraft {
  name: string;
  relation: string;
  about: string;
  /** The member id, when the person is a member of the space. */
  member: string | null;
}

export function personDraft(p: PersonDraft): MemoryDraft {
  const name = p.name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new Error("A person needs a name.");
  return {
    title: name,
    body: p.about.trim().slice(0, 4000),
    tags: p.relation.trim() ? [p.relation.trim().slice(0, 48)] : [],
    source: { kind: "person", ...(p.member ? { ref: p.member } : {}) },
  };
}

export interface StoryDraft {
  title: string;
  text: string;
  when: string;
  people: string[];
  tags?: string[];
  image?: MemoryDraft["image"];
}

export function storyDraft(s: StoryDraft): MemoryDraft {
  if (!s.title.trim() && !s.text.trim() && !s.image) throw new Error("A story needs a title, some text or a photo.");
  return { title: s.title.trim() || s.text.trim().slice(0, 80) || "A photo", body: s.text, when: cleanWhen(s.when) ?? null, people: s.people, tags: s.tags ?? [], image: s.image ?? null, source: { kind: "story" } };
}

export interface PersonView {
  id: string;
  name: string;
  relation: string;
  about: string;
  member: string | null;
}

export function peopleOf(memories: Memory[]): PersonView[] {
  return memories
    .filter((m) => m.source.kind === "person")
    .map((m) => ({ id: m.id, name: m.title, relation: m.tags[0] ?? "", about: m.body, member: m.source.ref ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The date a story sorts by: when it happened, or else when it was written down. */
export function storyDate(m: Pick<Memory, "when" | "createdAt">): string {
  return m.when ?? m.createdAt.slice(0, 10);
}

export interface TimelineYear<T> {
  year: string;
  stories: T[];
}

/** Stories (not people) by year, oldest first: how a history reads. */
export function timeline<T extends Memory>(memories: T[]): TimelineYear<T>[] {
  const stories = memories.filter((m) => m.source.kind !== "person").sort((a, b) => (storyDate(a) < storyDate(b) ? -1 : storyDate(a) > storyDate(b) ? 1 : a.createdAt < b.createdAt ? -1 : 1));
  const years: TimelineYear<T>[] = [];
  for (const s of stories) {
    const year = storyDate(s).slice(0, 4);
    const last = years[years.length - 1];
    if (last && last.year === year) last.stories.push(s);
    else years.push({ year, stories: [s] });
  }
  return years;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function whenLabel(when: string): string {
  const [y, m, d] = when.split("-");
  if (d) return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  if (m) return `${MONTHS[Number(m) - 1]} ${y}`;
  return y;
}

// ---------------------------------------------------------------- heirs

export interface HeirInput {
  id: string;
  publicKey: string;
  role: SpaceRole;
}

/** An heir is sealed and tagged as the member it will become. */
export async function sealHeir(raw: Uint8Array, spaceId: string, epoch: number, heir: HeirInput): Promise<SealedMember> {
  const m: SpaceMember = { id: heir.id, kind: "vault", publicKey: heir.publicKey, role: heir.role === "admin" ? "admin" : heir.role };
  return sealForMember(raw, spaceId, epoch, m);
}

// ---------------------------------------------------------------- a readable copy

export interface HistoryDocument {
  name: string;
  about: string;
  kind: "family" | "history" | "team";
  /** Names by member id, for "added by". */
  members: Record<string, string>;
  people: PersonView[];
  memories: (Memory & { author: string | null })[];
  madeAt: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

/**
 * The shared history as one self-contained HTML document, ready to read or
 * print to PDF: the people, then every story by year with its photo, who is in
 * it and who added it. Made on the device from the decrypted space.
 */
export function historyHtml(doc: HistoryDocument): string {
  const byId = new Map(doc.people.map((p) => [p.id, p]));
  const years = timeline(doc.memories);
  const people = doc.people
    .map(
      (p) =>
        `<li><strong>${esc(p.name)}</strong>${p.relation ? ` <span class="muted">${esc(p.relation)}</span>` : ""}${p.member ? ` <span class="muted">(a member)</span>` : ""}${p.about ? `<br>${esc(p.about)}` : ""}</li>`,
    )
    .join("\n");
  const stories = years
    .map(
      (y) =>
        `<section class="year"><h2>${esc(y.year)}</h2>\n${y.stories
          .map((s) => {
            const who = (s.people ?? []).map((id) => byId.get(id)?.name).filter(Boolean) as string[];
            const by = s.author ? doc.members[s.author] : undefined;
            const img = s.image ? `<figure><img src="data:${s.image.type};base64,${s.image.data}" alt="${esc(s.title)}"></figure>` : "";
            return `<article class="story"><h3>${esc(s.title)}</h3><p class="meta">${esc(s.when ? whenLabel(s.when) : `Written down ${s.createdAt.slice(0, 10)}`)}${
              who.length ? ` · With ${esc(who.join(", "))}` : ""
            }${by ? ` · Added by ${esc(by)}` : ""}</p>${img}${paragraphs(s.body)}</article>`;
          })
          .join("\n")}</section>`,
    )
    .join("\n");
  const title = esc(doc.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light; }
body { font: 16px/1.6 Georgia, "Times New Roman", serif; color: #111; background: #fff; margin: 0 auto; max-width: 42rem; padding: 2.5rem 1rem 4rem; }
h1 { font-size: 2rem; margin: 0 0 .25rem; }
h2 { font-size: 1.4rem; border-bottom: 1px solid #999; padding-bottom: .2rem; margin: 2.5rem 0 1rem; break-after: avoid; }
h3 { font-size: 1.1rem; margin: 0 0 .2rem; }
.muted, .meta { color: #555; font-size: .9rem; }
.story { margin: 0 0 1.75rem; break-inside: avoid; }
figure { margin: .6rem 0; }
img { max-width: 100%; height: auto; display: block; }
ul { padding-left: 1.2rem; }
footer { margin-top: 3rem; color: #555; font-size: .8rem; border-top: 1px solid #ccc; padding-top: .6rem; }
@media print { body { padding: 0; } a { color: inherit; } }
</style>
</head>
<body>
<header><h1>${title}</h1>${doc.about ? `<p class="muted">${esc(doc.about)}</p>` : ""}</header>
${people ? `<section><h2>People</h2><ul>${people}</ul></section>` : ""}
${stories || `<p class="muted">No stories yet.</p>`}
<footer>A copy of a shared memory, decrypted on the device that made it on ${esc(doc.madeAt.slice(0, 10))}.</footer>
</body>
</html>
`;
}
