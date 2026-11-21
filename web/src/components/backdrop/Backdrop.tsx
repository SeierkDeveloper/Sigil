// The page ground, behind every page: black, with two ribbons of fine parallel
// lines, the line language of the logo. The ribbons are one still drawing
// (public/backdrop-ribbon.svg, made by scripts/backdrop.mjs) placed twice. Each
// sits on its own layer and drifts very slowly, moved only by transform and
// opacity (see .backdrop in craft.css), so nothing here runs a script, reads
// the layout or repaints, and scrolling never waits for it. With reduced
// motion the ribbons stand still.

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-ribbon" data-ribbon="a" src="/backdrop-ribbon.svg" alt="" decoding="async" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="backdrop-ribbon" data-ribbon="b" src="/backdrop-ribbon.svg" alt="" decoding="async" />
    </div>
  );
}
