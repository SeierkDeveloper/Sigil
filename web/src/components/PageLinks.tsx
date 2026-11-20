import Link from "next/link";
import { navGroups } from "@/lib/site";
import { ArrowIcon } from "./icons";

const all = navGroups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })));

/** "Read next" at the foot of a page: links to other pages, with their one-line descriptions from the menu. */
export function PageLinks({ hrefs, title = "Read next" }: { hrefs: string[]; title?: string }) {
  const items = hrefs.map((h) => all.find((it) => it.href === h)).filter((it) => it !== undefined);
  return (
    <nav className="page-links" aria-label={title}>
      <p className="page-links-title">{title}</p>
      <ul className="page-links-list">
        {items.map((it) => (
          <li key={it.href}>
            <Link href={it.href} className="page-link">
              <span className="page-link-group">{it.group}</span>
              <span className="page-link-title">
                {it.label} <ArrowIcon />
              </span>
              <span className="page-link-text">{it.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
