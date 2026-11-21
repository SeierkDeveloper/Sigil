// The page ground in motion: the numbers handed to its shader.

import { describe, expect, it } from "vitest";
import { FRAGMENT, RIBBONS, ROUND, advance, layOut, makeUniforms } from "@/components/backdrop/groundShader";

const SCREENS: [number, number][] = [
  [390, 844],
  [1440, 900],
  [2560, 1440],
];

describe("page ground", () => {
  it("lays the ribbons out on a phone, a laptop and a large screen", () => {
    for (const [width, height] of SCREENS) {
      const u = makeUniforms();
      layOut(u, width, height);
      for (let i = 0; i < RIBBONS; i++) {
        const [x, y, dx, dy] = u.a.subarray(i * 4, i * 4 + 4);
        const [halfWidth, gaps, strength, turn] = u.b.subarray(i * 4, i * 4 + 4);
        expect(x).toBe(width / 2);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(height);
        expect(Math.hypot(dx, dy)).toBeCloseTo(1, 5);
        // lines stay apart where the ribbon lies flat, and the ribbon stays quiet
        expect((2 * halfWidth) / gaps).toBeGreaterThan(4);
        expect(strength).toBeLessThanOrEqual(0.4);
        expect(turn).toBeGreaterThan(0);
        expect(u.d[i * 2]).toBeGreaterThan(0);
      }
    }
  });

  it("moves, and comes round without a seam", () => {
    const start = makeUniforms();
    const later = makeUniforms();
    const round = makeUniforms();
    advance(start, 0);
    advance(later, 1);
    advance(round, ROUND);
    expect(Array.from(later.c)).not.toEqual(Array.from(start.c));
    for (const u of [start, later, round]) {
      for (const phase of [...u.c, ...Array.from({ length: RIBBONS }, (_, i) => u.d[i * 2 + 1])]) {
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(Math.PI * 2 + 1e-6);
      }
    }
    for (let i = 0; i < start.c.length; i++) {
      const gap = Math.abs(round.c[i] - start.c[i]);
      expect(Math.min(gap, Math.PI * 2 - gap)).toBeLessThan(1e-4);
    }
  });

  it("draws in white and grey only", () => {
    expect(FRAGMENT).toContain("gl_FragColor = vec4(vec3(ground + lines), 1.0)");
  });
});
