"use client";

import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path on this page, from the text alone. Dark
 * modules on a white plate, with the quiet zone scanners need around it.
 */
export function Qr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 0 });
    let d = "";
    qr.data.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        const start = x;
        while (x < row.length && row[x]) x++;
        d += `M${start + 4} ${y + 4}h${x - start}v1h-${x - start}z`;
      }
    });
    return { size: qr.size + 8, path: d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#050506" />
    </svg>
  );
}
