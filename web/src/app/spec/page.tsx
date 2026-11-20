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
    "The Sigil open standard, version 1.1: the memory format, folder keys and sealed boxes, the connector's tools and permissions, the access log, hourly seals and presence, certificates, the AI self's identity and wallet, proofs of a fact, the emergency card, agreements and knowledge packs, with test vectors generated from the code.",
};

/** The standard's files in docs/spec, rendered as one document. Links between parts become links within this page. */
export default function SpecPage() {
  const parts = specParts();
  const ids = new Map(parts.map((p) => [p.file, p.id]));
  const link = (href: string) => {
    if (href === "vectors.json") return "/spec/vectors.json";
    const [file, hash] = href.split("#");
    if (ids.has(file)) return `#${hash ? `${ids.get(file)}-${hash}` : ids.get(file)}`;
    return href;
  };
  // The overview's own title and version line are the page's masthead; here it opens as "Overview".
  const version = /^Version\s+(\S+)/m.exec(parts.find((p) => p.id === "overview")?.source ?? "")?.[1] ?? null;
  const rendered = parts.map((p) => {
    const source = p.id === "overview" ? p.source.replace(/^#\s.*\n+(?:Version\s.*\n+)?/, "# Overview\n\n") : p.source;
    return { ...p, ...renderMarkdown(source, { idPrefix: p.id, link }) };
  });
  return (
    <div className="page spec-page">
      <div className="container">
        <PageHeader
          eyebrow="Developers"
          title="The Sigil open standard"
          lead="How a vault keeps memories, how its keys work, what a connector may do, what the access log records and how it is sealed. Build your own vault, connector or checker from it."
        />
        <dl className="spec-sheet">
          {version ? (
            <div>
              <dt>Version</dt>
              <dd>{version}</dd>
            </div>
          ) : null}
          <div>
            <dt>Parts</dt>
            <dd>{rendered.length - 1}</dd>
          </div>
          <div>
            <dt>Reference code</dt>
            <dd>
              <a href={`${site.githubUrl}/tree/main/packages/core`}>packages/core</a>
            </dd>
          </div>
          <div>
            <dt>Test vectors</dt>
            <dd>
              <a href="/spec/vectors.json">vectors.json</a>
            </dd>
          </div>
        </dl>
        <div className="doc-layout spec-layout">
          <nav className="doc-aside spec-aside" aria-label="Parts of the standard">
            <p className="doc-aside-label">Contents</p>
            <ol className="spec-index">
              {rendered.map((p) => (
                <li key={p.id}>
                  <a href={`#${p.id}`}>{p.headings[0]?.text ?? p.file}</a>
                  <ol className="spec-index-sub">
                    {p.headings
                      .filter((h) => h.depth === 2)
                      .map((h) => (
                        <li key={h.id}>
                          <a href={`#${h.id}`}>{h.text.replace(/`/g, "")}</a>
                        </li>
                      ))}
                  </ol>
                </li>
              ))}
              <li>
                <a href="/spec/vectors.json">Test vectors</a>
              </li>
            </ol>
          </nav>
          <div className="prose spec-doc">
            {rendered.map((p) => (
              <section key={p.id} id={p.id} className="doc-section spec-part" data-part={p.id}>
                {p.nodes}
                <p className="spec-source">
                  Source: <a href={`${site.githubUrl}/blob/main/docs/spec/${p.file}`}>docs/spec/{p.file}</a>
                </p>
              </section>
            ))}
          </div>
        </div>
        <PageLinks hrefs={["/connector", "/verify", "/docs/api"]} />
      </div>
    </div>
  );
}
