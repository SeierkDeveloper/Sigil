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

// The mark of the printed copy: five fine parallel lines with angled ends, drawn so it prints on any paper.
const RULE_MARK = `<svg class="mark" viewBox="0 0 72 9" width="72" height="9" aria-hidden="true"><path d="M8 .5H72M6 2.5H70M4 4.5H68M2 6.5H66M0 8.5H64" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;

const HISTORY_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #e8e8e8; }
body { margin: 0; color: #111; font: 11.5pt/1.6 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; font-kerning: normal; }
.sheet { max-width: 46rem; margin: 2.5rem auto; padding: 4.5rem 4.75rem 3.5rem; background: #fff; border: 1px solid #cfcfcf; }
h1, h2, h3 { margin: 0; font-family: Didot, "Bodoni 72", "Bodoni MT", "Iowan Old Style", Georgia, serif; font-weight: 400; }
.title { margin: 0 0 3.25rem; }
.kicker, .count, .people > h2, footer { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 7.5pt; letter-spacing: .2em; text-transform: uppercase; color: #555; }
.kicker { margin: 0 0 1.4rem; }
h1 { font-size: 34pt; line-height: 1.06; letter-spacing: -.015em; overflow-wrap: anywhere; }
.about { max-width: 34rem; margin: .9rem 0 0; font-size: 13pt; font-style: italic; line-height: 1.45; color: #333; }
.mark { display: block; margin: 1.7rem 0 0; color: #111; }
.count { margin: .9rem 0 0; }
.people { margin: 0 0 3rem; padding: 1.1rem 0 1.2rem; border-top: 1px solid #111; border-bottom: 1px solid #bbb; }
.people > h2 { margin: 0 0 .8rem; }
.people ul { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 2.5rem; }
.people li { margin: 0 0 .55rem; break-inside: avoid; font-size: 10.5pt; line-height: 1.45; }
.people strong { font-weight: 600; }
.muted { color: #555; }
.people .muted { font-style: italic; }
.year { margin: 0 0 2.6rem; }
.year > h2 { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.3rem; font-size: 30pt; line-height: 1; font-variant-numeric: lining-nums; break-after: avoid; }
.year > h2::after { content: ""; flex: 1; border-top: 1px solid #111; }
.story { margin: 0 0 2rem; }
.story:last-child { margin-bottom: 0; }
.story + .story { padding-top: 1.6rem; border-top: 1px solid #d5d5d5; }
h3 { font-size: 17pt; line-height: 1.2; break-after: avoid; overflow-wrap: anywhere; }
.meta { margin: .3rem 0 0; font-size: 9.5pt; font-style: italic; color: #555; break-after: avoid; }
figure { width: fit-content; max-width: 100%; margin: 1rem 0 0; padding: 6px; border: 1px solid #bbb; break-inside: avoid; }
img { display: block; max-width: 100%; max-height: 30rem; height: auto; }
.story p:not(.meta) { max-width: 36rem; margin: .8rem 0 0; hyphens: auto; orphans: 3; widows: 3; overflow-wrap: anywhere; }
.none { margin: 0 0 2.6rem; font-style: italic; color: #555; }
footer { display: flex; align-items: center; gap: 1rem; margin: 3.5rem 0 0; padding: 1rem 0 0; border-top: 1px solid #111; letter-spacing: .12em; line-height: 1.6; }
footer .mark { flex: none; margin: 0; }
@media (max-width: 40rem) {
  html { background: #fff; }
  .sheet { margin: 0; padding: 2rem 1.25rem 2.5rem; border: 0; }
  h1 { font-size: 26pt; }
  .year > h2 { font-size: 24pt; }
  .people ul { columns: 1; }
}
@page { margin: 22mm 21mm 24mm; @bottom-center { content: counter(page); font: 8pt "Helvetica Neue", Helvetica, Arial, sans-serif; color: #555; } }
@media print {
  html { background: #fff; }
  body { font-size: 10.5pt; }
  .sheet { max-width: none; margin: 0; padding: 0; border: 0; }
  .title { margin-bottom: 14mm; padding-top: 18mm; }
  img { max-height: 105mm; }
  a { color: inherit; text-decoration: none; }
}
`;

/**
 * The shared history as one self-contained HTML document, ready to read or
 * print to PDF: the people, then every story by year with its photo, who is in
 * it and who added it. Made on the device from the decrypted space. It is set
 * as a printed book would be, in black on white, in the faces the reader's own
 * device has, and fetches nothing.
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
  const count = years.reduce((n, y) => n + y.stories.length, 0);
  const span = years.length ? (years.length > 1 ? `${years[0].year} to ${years[years.length - 1].year}` : years[0].year) : "";
  const kicker = doc.kind === "family" ? "A family history" : doc.kind === "history" ? "A team history" : "A shared memory";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${HISTORY_STYLE}</style>
</head>
<body>
<main class="sheet">
<header class="title"><p class="kicker">${kicker}</p><h1>${title}</h1>${doc.about ? `<p class="about">${esc(doc.about)}</p>` : ""}${RULE_MARK}${
    count ? `<p class="count">${count} ${count === 1 ? "story" : "stories"}, ${esc(span)}</p>` : ""
  }</header>
${people ? `<section class="people"><h2>People</h2><ul>${people}</ul></section>` : ""}
${stories || `<p class="none">No stories yet.</p>`}
<footer>${RULE_MARK}<span>A copy of a shared memory, decrypted on the device that made it on ${esc(doc.madeAt.slice(0, 10))}.</span></footer>
</main>
</body>
</html>
`;
}
