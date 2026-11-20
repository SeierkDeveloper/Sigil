import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { releases } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What has been built in Sigil so far, release by release.",
};

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default function Changelog() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Changelog"
          title="What has been built"
          lead="Every entry here is in the code today. Plans live on the roadmap; this page only lists what shipped."
        />

        <ol className="releases">
          {releases.map((r) => (
            <li key={r.title} className="release">
              <div className="release-side">
                <time dateTime={r.date} className="release-date">
                  {day(r.date)}
                </time>
                <span className="badge">{r.area}</span>
              </div>
              <div className="release-main">
                <h2 className="release-title">{r.title}</h2>
                <p className="release-summary">{r.summary}</p>
                <ul className="stage-items">
                  {r.items.map((it) => (
                    <li key={it} className="stage-item" data-built="true">
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>

        <PageLinks hrefs={["/roadmap", "/ai-self", "/open-source"]} />
      </div>
    </div>
  );
}
