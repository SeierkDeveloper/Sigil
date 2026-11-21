// The page ground, behind every page: black, with an engraved landscape low
// on the screen. Far hills, a field and its grass, cut in fine lines.
//
// Two things draw it. The still drawing is one picture
// (public/backdrop-land.svg, made by scripts/backdrop.mjs from the same
// shapes); it is in the page from the first paint and needs no script. Over it
// lies the ground in motion (Ground.tsx): one canvas drawn on the graphics
// card, which fades in once it runs and covers the still drawing. With reduced
// motion, without WebGL or on a slow graphics card the canvas stays away and
// the still drawing is the ground. Styled in engraved.css.

import { Ground } from "./Ground";

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-land" src="/backdrop-land.svg" alt="" decoding="async" />
      <Ground />
    </div>
  );
}
