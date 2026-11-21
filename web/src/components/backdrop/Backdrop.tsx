// The page ground, behind every page: black, with ribbons of fine parallel
// lines, the line language of the logo.
//
// Two things draw it. The still drawing is two copies of one picture
// (public/backdrop-ribbon.svg, made by scripts/backdrop.mjs); it is in the
// page from the first paint and needs no script. Over it lies the ground in
// motion (Ground.tsx): one canvas drawn on the graphics card, which fades in
// once it runs and covers the still drawing. With reduced motion, without
// WebGL or on a slow graphics card the canvas stays away and the still
// drawing is the ground. Styled at the top of craft.css.

import { Ground } from "./Ground";

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-ribbon" data-ribbon="a" src="/backdrop-ribbon.svg" alt="" decoding="async" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-ribbon" data-ribbon="b" src="/backdrop-ribbon.svg" alt="" decoding="async" />
      <Ground />
    </div>
  );
}
