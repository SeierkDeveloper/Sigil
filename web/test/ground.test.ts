// The page ground in motion: the numbers handed to its shader.

import { describe, expect, it } from "vitest";
import { FRAGMENT, GRASS, LAND, ROUND, STRENGTH, TURNS, advance, layOut, makeUniforms } from "@/components/backdrop/groundShader";

const SCREENS: [number, number][] = [
  [390, 844],
  [1440, 900],
  [2560, 1440],
];

describe("page ground", () => {
  it("lays the land out low on a phone, a laptop and a large screen", () => {
    for (const [width, height] of SCREENS) {
      const u = makeUniforms();
      layOut(u, width, height);
      const [horizon, scale] = u.scene;
      // the land keeps to the lowest quarter of the screen, and its lines stay a sensible size
      expect(horizon).toBeGreaterThan(height * 0.75);
      expect(horizon).toBeLessThan(height * 0.9);
      expect(scale).toBeGreaterThanOrEqual(0.7);
      expect(scale).toBeLessThanOrEqual(1.4);
      // the far hill stands behind the near one, and both above the field, right across the screen
      for (let x = 0; x <= width / scale; x += 10) {
        expect(LAND.far(x)).toBeLessThan(LAND.near(x));
        expect(LAND.near(x)).toBeLessThan(LAND.field(x));
        expect(horizon + LAND.far(x) * scale).toBeGreaterThan(height * 0.55);
      }
    }
  });

  it("stays quiet: no line brighter than three tenths of white", () => {
    for (const strength of Object.values(STRENGTH)) {
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(0.3);
    }
    // a blade of grass never leans out of the two cells the shader looks in
    for (const [, tall, apart] of GRASS) expect(tall * (0.45 + 0.4) + 0.2 * tall).toBeLessThan(apart * 1.5);
  });

  it("moves, and comes round without a seam", () => {
    const start = makeUniforms();
    const later = makeUniforms();
    const round = makeUniforms();
    advance(start, 0);
    advance(later, 1);
    advance(round, ROUND);
    expect(Array.from(later.clock)).not.toEqual(Array.from(start.clock));
    for (const turns of TURNS) expect(Number.isInteger(turns)).toBe(true);
    for (const u of [start, later, round]) {
      for (const phase of u.clock) {
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(Math.PI * 2 + 1e-6);
      }
    }
    for (let i = 0; i < start.clock.length; i++) {
      const gap = Math.abs(round.clock[i] - start.clock[i]);
      expect(Math.min(gap, Math.PI * 2 - gap)).toBeLessThan(1e-4);
    }
  });

  it("draws in white and grey only", () => {
    expect(FRAGMENT).toContain("gl_FragColor = vec4(vec3(ground + ink), 1.0)");
  });
});
