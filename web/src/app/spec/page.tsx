import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { renderMarkdown } from "@/lib/markdown";
import { specParts } from "@/lib/spec";
import { site } from "@/lib/site";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Open standard",
  description:
    "The Sigil open standard, version 1: the memory format, folder keys and sealed boxes, the connector's tools and permissions, the access log, hourly seals and presence, and certificates, with test vectors generated from the code.",
};

/** The standard's files in docs/spec, rendered on one page. Links between parts become links within this page. */
export default function SpecPage() {
  const parts = specParts();
  const ids = new Map(parts.map((p) => [p.file, p.id]));
  const link = (href: string) => {
    if (href === "vectors.json") return "/spec/vectors.json";
    const [file, hash] = href.split("#");
    if (ids.has(file)) return `#${hash ? `${ids.get(file)}-${hash}` : ids.get(file)}`;
    return href;
  };
  const rendered = parts.map((p) => ({ ...p, ...renderMarkdown(p.source, { idPrefix: p.id, link }) }));
  return (
    <div className="page spec-page">
      <div className="container container-narrow">
        <PageHeader
          eyebrow="Developers"
          title="The Sigil open standard"
          lead="How a vault keeps memories, how its keys work, what a connector may do, what the access log records and how it is sealed. Build your own vault, connector or checker from it."
        />
        <nav aria-label="Parts of the standard">
          <ul className="toc spec-index">
            {rendered.map((p) => (
              <li key={p.id}>
                <a href={`#${p.id}`}>{p.headings[0]?.text ?? p.file}</a>
              </li>
            ))}
            <li>
              <a href="/spec/vectors.json">Test vectors</a>
            </li>
          </ul>
        </nav>
        <div className="prose">
          {rendered.map((p) => (
            <section key={p.id} id={p.id} className="doc-section">
              {p.nodes}
              <p className="small faint">
                Source: <a href={`${site.githubUrl}/blob/main/docs/spec/${p.file}`}>docs/spec/{p.file}</a>
              </p>
            </section>
          ))}
        </div>
        <PageLinks hrefs={["/connector", "/verify", "/docs/api"]} />
      </div>
    </div>
  );
}
