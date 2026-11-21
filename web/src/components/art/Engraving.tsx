// One engraving from public/art (cut by scripts/engravings.mjs), placed as a
// picture. With motion on it is uncovered once as it enters the screen, from
// the ground up or, for roots, from the ground down: a window slides over the
// picture while the picture stays where it is, so only transforms move
// (engraved.css, "engravings").
//
// The two wide ones, the roots and the far range, are printed in dots like the
// oak of the first screen: the page shows their tone (public/art/dots, made by
// scripts/halftone.mjs) through the screen of dots (dotted.css).

export const ART = {
  acorn: [260, 260],
  sapling: [300, 400],
  oak: [640, 560],
  leaf: [300, 300],
  sprig: [420, 240],
  rings: [600, 600],
  seal: [360, 360],
  roots: [1400, 600],
  range: [1600, 480],
} as const;

export type ArtName = keyof typeof ART;

/** Printed in dots. */
const DOTTED: Partial<Record<ArtName, true>> = { roots: true, range: true };

export function Engraving({ name, grow = "up", className }: { name: ArtName; grow?: "up" | "down" | "none"; className?: string }) {
  const [width, height] = ART[name];
  return (
    <span className={`engraving${className ? ` ${className}` : ""}`} data-art={name} data-grow={grow} data-dots={DOTTED[name]} aria-hidden="true">
      <span className="engraving-window">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={DOTTED[name] ? `/art/dots/${name}.webp` : `/art/${name}.svg`} alt="" width={width} height={height} loading="lazy" decoding="async" />
      </span>
    </span>
  );
}
