// A small Markdown renderer for the open standard's pages: headings, paragraphs,
// lists, tables, code blocks, inline code, bold and links. It builds React
// elements (never raw HTML), so nothing in a file can inject markup.

import { Fragment, type ReactNode } from "react";

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Bold, inline code and links in one line of text. `link` rewrites a link's target. */
function inline(text: string, link: (href: string) => string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k}>{inline(t.slice(2, -2), link, k)}</strong>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        <a key={k} href={link(lm[2])}>
          {inline(lm[1], link, k)}
        </a>,
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/** Renders a Markdown document. Heading ids are prefixed so several documents can share one page. */
export function renderMarkdown(source: string, opts: { idPrefix?: string; link?: (href: string) => string } = {}): { nodes: ReactNode; headings: Heading[] } {
  const link = opts.link ?? ((h) => h);
  const prefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  const headings: Heading[] = [];
  let i = 0;
  let n = 0;
  const key = () => `md-${n++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      nodes.push(
        <pre key={key()} className="code-block-pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const text = h[2].trim();
      const id = `${prefix}${slug(text)}`;
      headings.push({ depth, text, id });
      const Tag = (depth === 1 ? "h2" : depth === 2 ? "h3" : "h4") as "h2" | "h3" | "h4";
      nodes.push(
        <Tag key={key()} id={id}>
          {inline(text, link)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().startsWith("|") && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      const k = key();
      nodes.push(
        <div key={k} className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, link, `${k}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, link, `${k}-${ri}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const listItem = /^(\s*)(-|\d+\.)\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && listItem.test(lines[i])) {
        let text = listItem.exec(lines[i])![3];
        i++;
        while (i < lines.length && lines[i].trim() && !listItem.test(lines[i]) && /^\s+/.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(text);
      }
      const k = key();
      const children = items.map((t, j) => <li key={j}>{inline(t, link, `${k}-${j}`)}</li>);
      nodes.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*(-|\d+\.)\s|\|)/.test(lines[i])) para.push(lines[i++].trim());
    if (para.length === 0) {
      para.push(lines[i++].trim());
    }
    const k = key();
    nodes.push(<p key={k}>{inline(para.join(" "), link, k)}</p>);
  }
  return { nodes: <Fragment>{nodes}</Fragment>, headings };
}
