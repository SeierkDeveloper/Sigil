// One engraving from public/art (cut by scripts/engravings.mjs), placed as a
// picture. With motion on it is uncovered once as it enters the screen, from
// the ground up or, for roots, from the ground down: a window slides over the
// picture while the picture stays where it is, so only transforms move
// (engraved.css, "engravings").

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

export function Engraving({ name, grow = "up", className }: { name: ArtName; grow?: "up" | "down" | "none"; className?: string }) {
  const [width, height] = ART[name];
  return (
    <span className={`engraving${className ? ` ${className}` : ""}`} data-art={name} data-grow={grow} aria-hidden="true">
      <span className="engraving-window">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/art/${name}.svg`} alt="" width={width} height={height} loading="lazy" decoding="async" />
      </span>
    </span>
  );
}
