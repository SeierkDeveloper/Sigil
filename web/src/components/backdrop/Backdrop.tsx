// The page ground, behind every page: black, with a landscape low on the
// screen printed in dots. Far hills, a field and its grass, and a faint cold
// light in the sky.
//
// Two things draw it. The still ground is one small tone picture of the land
// (public/art/dots/land.webp, printed by scripts/halftone.mjs from land.ts)
// and a gradient for the sky's light, both seen through a mask of dots; it is
// in the page from the first paint and needs no script. Over it lies the
// ground in motion (Ground.tsx): one canvas drawn on the graphics card, which
// fades in once it runs and covers the still ground. With reduced motion,
// without WebGL or on a slow graphics card the canvas stays away and the
// still ground is the ground. Styled in craft.css and dotted.css.

import { Ground } from "./Ground";

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <span className="backdrop-sky" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-land" src="/art/dots/land.webp" alt="" decoding="async" />
      <Ground />
    </div>
  );
}
