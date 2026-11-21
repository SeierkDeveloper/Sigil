// The page ground in motion: the numbers handed to its shader.

import { describe, expect, it } from "vitest";
import { PITCH, PITCH_SMALL, SKY, fitDots, pitchFor } from "@/components/art/dots";
import { FRAGMENT, LAND, LAND_STILL, ROUND, STRENGTH, TURNS, advance, landTone, layOut, makeUniforms } from "@/components/backdrop/groundShader";
import { layOutHero } from "@/components/hero/heroArtShader";

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

  it("stays quiet: no dot brighter than three tenths of white", () => {
    for (const strength of Object.values(STRENGTH)) {
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(0.3);
    }
    // the still drawing is the same land: lit along the hills, dark above them, never over the limit
    const { width, top, bottom, step } = LAND_STILL;
    let lit = 0;
    for (let x = 0; x < width; x += 40) {
      expect(landTone(x, LAND.far(x) - 3 * step, step)).toBe(0);
      expect(landTone(x, LAND.near(x) + 1, step)).toBeGreaterThan(0.05);
      for (let y = top; y < bottom; y += step) {
        const tone = landTone(x, y, step);
        expect(tone).toBeLessThanOrEqual(0.3);
        if (tone > 0.02) lit++;
      }
    }
    expect(lit).toBeGreaterThan(200);
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

  it("draws in white and grey, with the sky's cold light as the only colour", () => {
    expect(FRAGMENT).toContain("gl_FragColor = vec4(vec3(ground) + ink * mix(vec3(1.0), vec3(");
    // a cold blue silver: more blue than green, more green than red, and still pale
    expect(SKY[2]).toBeGreaterThan(SKY[1]);
    expect(SKY[1]).toBeGreaterThan(SKY[0]);
    expect(SKY[2] - SKY[0]).toBeLessThan(0.35);
  });
});

describe("the screen of dots", () => {
  it("is finer on a phone", () => {
    expect(pitchFor(390)).toBe(PITCH_SMALL);
    expect(pitchFor(1440)).toBe(PITCH);
  });

  it("gives every dot a whole number of canvas pixels and keeps to the limit", () => {
    for (const [width, height] of SCREENS) {
      for (const density of [1, 2, 3]) {
        for (const quality of [1, 0.6]) {
          const fit = fitDots(width, height, density, 3_400_000, quality);
          expect(Number.isInteger(fit.step)).toBe(true);
          expect(fit.step).toBeGreaterThanOrEqual(3);
          // never sharper than twice the CSS size
          expect(fit.step).toBeLessThanOrEqual(2 * pitchFor(width));
          expect(fit.px).toBeCloseTo(pitchFor(width) / fit.step);
          if (fit.step > 3) expect(fit.width * fit.height).toBeLessThanOrEqual(3_400_000 * 1.01);
        }
      }
    }
    expect(fitDots(1440, 900, 2, 3_400_000).step).toBeGreaterThan(fitDots(1440, 900, 1, 3_400_000).step);
  });
});

describe("the art of the first screen", () => {
  it("stands the oak at the foot of the piece, beside the words or under them", () => {
    const wide = layOutHero(1440, 790);
    expect(wide.tree[0] + wide.tree[2]).toBeCloseTo(1440);
    expect(wide.tree[1] + wide.tree[3]).toBeCloseTo(790);
    // the crown starts right of the words
    expect(wide.tree[0] + 0.35 * wide.tree[2]).toBeGreaterThan(640);
    const phone = layOutHero(390, 560);
    expect(phone.tree[1] + phone.tree[3]).toBeCloseTo(560);
    // the trunk stands on the screen
    const trunk = phone.tree[0] + 0.727 * phone.tree[2];
    expect(trunk).toBeGreaterThan(390 * 0.4);
    expect(trunk).toBeLessThan(390 * 0.8);
    // on a phone the sky rises out of black: nothing at the top edge of the piece
    expect(phone.sky[0]).toBe(0);
    expect(phone.sky[1]).toBeGreaterThan(0);
  });
});
