// GitHub: a repository's commit history, or a person's recent public activity.
// The browser asks GitHub directly; a personal token, when one is given, is
// used for those requests only and is never stored or sent to Sigil. Commits
// and events are grouped into one memory per day.

import type { MemoryDraft } from "../vault";
import { LocalImportError, LOCAL_LABELS, type LocalImport } from "./files";

export interface GithubCommit {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } | null; committer?: { date?: string } | null };
}

export interface GithubEvent {
  type?: string;
  created_at?: string;
  repo?: { name?: string };
  payload?: Record<string, unknown>;
}

export const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const USER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Accepts owner/name or a github.com address. */
export function parseRepo(input: string): string | null {
  const t = input.trim().replace(/\.git$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)/i.exec(t);
  const repo = m ? m[1] : t;
  return REPO_PATTERN.test(repo) ? repo : null;
}

const day = (iso: string) => iso.slice(0, 10);

function byDay<T>(items: T[], when: (x: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of items) {
    const w = when(x);
    if (!w || !Number.isFinite(new Date(w).getTime())) continue;
    const d = day(new Date(w).toISOString());
    out.set(d, [...(out.get(d) ?? []), x]);
  }
  return out;
}

function repoTag(repo: string): string {
  return repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
}

export function commitDrafts(repo: string, commits: GithubCommit[]): MemoryDraft[] {
  const drafts: MemoryDraft[] = [];
  for (const [d, list] of byDay(commits, (c) => c.commit?.author?.date ?? c.commit?.committer?.date ?? undefined)) {
    const sorted = [...list].sort((a, b) => ((a.commit?.author?.date ?? "") < (b.commit?.author?.date ?? "") ? -1 : 1));
    const lines = sorted.map((c) => {
      const [first, ...rest] = (c.commit?.message ?? "").trim().split("\n");
      const more = rest.join("\n").trim();
      const who = c.commit?.author?.name ? `, ${c.commit.author.name}` : "";
      return `- ${first || "(no message)"} (${(c.sha ?? "").slice(0, 7)}${who})${more ? `\n  ${more.replace(/\n/g, "\n  ").slice(0, 1500)}` : ""}`;
    });
    const times = sorted.map((c) => c.commit?.author?.date).filter((x): x is string => !!x);
    drafts.push({
      title: `${repo}: ${list.length} ${list.length === 1 ? "commit" : "commits"} on ${d}`,
      body: lines.join("\n"),
      tags: ["github", "commits", repoTag(repo)],
      source: { kind: "github", ref: `${repo}@${d}` },
      createdAt: times[0] ? new Date(times[0]).toISOString() : `${d}T00:00:00.000Z`,
      editedAt: times.length ? new Date(times[times.length - 1]).toISOString() : `${d}T00:00:00.000Z`,
    });
  }
  return drafts;
}

function describeEvent(e: GithubEvent): string | null {
  const repo = e.repo?.name ?? "a repository";
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.type) {
    case "PushEvent": {
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const n = Number(p.size ?? commits.length) || commits.length;
      const msgs = commits.map((c: { message?: string }) => `  - ${String(c.message ?? "").split("\n")[0]}`).slice(0, 20);
      return `Pushed ${n} ${n === 1 ? "commit" : "commits"} to ${repo}${msgs.length ? `\n${msgs.join("\n")}` : ""}`;
    }
    case "PullRequestEvent":
      return `${cap(String(p.action ?? "updated"))} pull request #${p.number ?? p.pull_request?.number ?? "?"} in ${repo}: ${p.pull_request?.title ?? ""}`.trim();
    case "IssuesEvent":
      return `${cap(String(p.action ?? "updated"))} issue #${p.issue?.number ?? "?"} in ${repo}: ${p.issue?.title ?? ""}`.trim();
    case "IssueCommentEvent":
      return `Commented on #${p.issue?.number ?? "?"} in ${repo}: ${String(p.comment?.body ?? "").replace(/\s+/g, " ").slice(0, 280)}`;
    case "PullRequestReviewEvent":
      return `Reviewed pull request #${p.pull_request?.number ?? "?"} in ${repo}`;
    case "CreateEvent":
      return p.ref_type === "repository" ? `Created the repository ${repo}` : `Created ${p.ref_type ?? "a branch"} ${p.ref ?? ""} in ${repo}`.trim();
    case "DeleteEvent":
      return `Deleted ${p.ref_type ?? "a branch"} ${p.ref ?? ""} in ${repo}`.trim();
    case "ReleaseEvent":
      return `Released ${p.release?.name || p.release?.tag_name || "a version"} of ${repo}`;
    case "WatchEvent":
      return `Starred ${repo}`;
    case "ForkEvent":
      return `Forked ${repo}`;
    case "PublicEvent":
      return `Made ${repo} public`;
    default:
      return null;
  }
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function eventDrafts(user: string, events: GithubEvent[]): { drafts: MemoryDraft[]; skipped: number } {
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  for (const [d, list] of byDay(events, (e) => e.created_at)) {
    const sorted = [...list].sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1));
    const lines: string[] = [];
    for (const e of sorted) {
      const line = describeEvent(e);
      if (line) lines.push(`- ${line}`);
      else skipped++;
    }
    if (!lines.length) continue;
    const repos = [...new Set(sorted.map((e) => e.repo?.name).filter((x): x is string => !!x && REPO_PATTERN.test(x)))];
    drafts.push({
      title: `GitHub activity of ${user} on ${d}`,
      body: lines.join("\n"),
      tags: ["github", "activity", ...repos.slice(0, 5).map(repoTag)],
      source: { kind: "github", ref: `${user}/activity@${d}` },
      createdAt: sorted[0].created_at ? new Date(sorted[0].created_at).toISOString() : undefined,
      editedAt: sorted[sorted.length - 1].created_at ? new Date(sorted[sorted.length - 1].created_at!).toISOString() : undefined,
    });
  }
  return { drafts, skipped };
}

// ---------------------------------------------------------------- asking GitHub, from the device

export type GithubFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubRequest {
  mode: "repo" | "user";
  /** owner/name for a repository, a user name for activity. */
  target: string;
  /** A personal access token. Used for these requests only, never stored. */
  token?: string;
  fetcher?: GithubFetcher;
  /** Pages of 100 to read at most (commits: 10, so up to 1,000; activity: GitHub keeps 300 events). */
  maxPages?: number;
  onProgress?: (fetched: number) => void;
}

async function getJson(fetcher: GithubFetcher, url: string, token?: string): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new LocalImportError("GitHub could not be reached from this browser.");
  }
  if (res.status === 401) throw new LocalImportError("GitHub did not accept the token.");
  if (res.status === 404) throw new LocalImportError("GitHub has no such repository or user, or the token cannot see it.");
  if (res.status === 403 || res.status === 429) throw new LocalImportError("GitHub's request limit was reached. Add a token, or try again later.");
  if (res.status === 409) return []; // An empty repository.
  if (!res.ok) throw new LocalImportError(`GitHub answered ${res.status}.`);
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

export async function importGithub(req: GithubRequest): Promise<LocalImport> {
  const fetcher = req.fetcher ?? ((u, i) => fetch(u, i));
  const token = req.token?.trim() || undefined;
  if (req.mode === "repo") {
    const repo = parseRepo(req.target);
    if (!repo) throw new LocalImportError("Write the repository as owner/name.");
    const commits: GithubCommit[] = [];
    const pages = Math.min(Math.max(req.maxPages ?? 10, 1), 30);
    for (let page = 1; page <= pages; page++) {
      const batch = (await getJson(fetcher, `https://api.github.com/repos/${repo}/commits?per_page=100&page=${page}`, token)) as GithubCommit[];
      commits.push(...batch);
      req.onProgress?.(commits.length);
      if (batch.length < 100) break;
    }
    if (!commits.length) throw new LocalImportError("That repository has no commits to import.");
    const notes = commits.length >= pages * 100 ? [`The newest ${commits.length.toLocaleString("en-US")} commits were read.`] : [];
    return { kind: "github", label: LOCAL_LABELS.github, drafts: commitDrafts(repo, commits), skipped: 0, notes };
  }
  const user = req.target.trim().replace(/^@/, "");
  if (!USER_PATTERN.test(user)) throw new LocalImportError("That is not a GitHub user name.");
  const events: GithubEvent[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = (await getJson(fetcher, `https://api.github.com/users/${user}/events?per_page=100&page=${page}`, token)) as GithubEvent[];
    events.push(...batch);
    req.onProgress?.(events.length);
    if (batch.length < 100) break;
  }
  if (!events.length) throw new LocalImportError("GitHub shows no recent activity for that user.");
  const r = eventDrafts(user, events);
  return { kind: "github", label: LOCAL_LABELS.github, drafts: r.drafts, skipped: r.skipped, notes: ["GitHub keeps about the last 90 days of activity."] };
}
