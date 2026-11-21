import { Engraving, type ArtName } from "@/components/art/Engraving";

// One engraving at the head of the pages where it says something about the
// page: growth where things begin, the rings of years, the seal. Named by the
// page's label, so a page only has to keep its label.
const HEAD_ART: Record<string, ArtName> = {
  "How it works": "sapling",
  Import: "acorn",
  Apps: "sprig",
  Vision: "oak",
  Roadmap: "rings",
  Legacy: "oak",
  Seals: "seal",
  Verify: "seal",
  "Open source": "leaf",
};

export function PageHeader({ eyebrow, title, lead }: { eyebrow?: string; title: string; lead?: React.ReactNode }) {
  const art = eyebrow ? HEAD_ART[eyebrow] : undefined;
  return (
    <header className="page-header" data-art={art}>
      {art ? <Engraving name={art} className="page-header-art" /> : null}
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1 className="page-title">{title}</h1>
      {lead ? <p className="page-lead">{lead}</p> : null}
    </header>
  );
}
