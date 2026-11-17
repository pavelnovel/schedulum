/*
 * Copied from pavelnovel/pavelnovel src/lib/sketch.ts so the marks here are
 * drawn by the same hand as the site. Keep the two in step when either changes.
 */

/**
 * Hand-drawn geometry.
 *
 * Two decisions make these marks cheap:
 *
 * They are generated at build time from a seeded PRNG, so a given mark is
 * byte-identical on every load. A library that re-randomises on each render
 * redraws the same circle differently every refresh, which reads as a glitch
 * rather than a pen.
 *
 * They are drawn in a normalised 100x100 box and stretched to fit whatever
 * they annotate (`preserveAspectRatio="none"` plus `vector-effect:
 * non-scaling-stroke`, so the stroke stays even while the shape distorts).
 * That means no measuring text at runtime — which is the thing that forces
 * annotation libraries to be JavaScript in the first place.
 *
 * Every path also carries `pathLength="1"`, so the draw-on animation is a
 * plain CSS transition from `stroke-dashoffset: 1` to `0` with nothing to
 * compute.
 */

export type SketchType = 'underline' | 'circle' | 'bracket' | 'strike' | 'box';

type Pt = [number, number];

/** mulberry32: small, fast, and identical across runs and machines. */
function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Quadratic smoothing through the sampled points. A polyline of jittered
 * points looks like a seismograph; curving through them looks like a pen.
 */
function smooth(points: Pt[]): string {
  if (points.length < 2) return '';

  let d = `M${r2(points[0][0])} ${r2(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r2(cx)} ${r2(cy)} ${r2((cx + nx) / 2)} ${r2((cy + ny) / 2)}`;
  }

  const last = points[points.length - 1];
  return `${d}L${r2(last[0])} ${r2(last[1])}`;
}

/**
 * A stroke from one point to another. The ends are pinned and the middle is
 * free to wander, plus one slow bow across the whole span — a hand pivots
 * from the wrist, so a drawn line arcs before it wobbles.
 */
function stroke(rand: () => number, a: Pt, b: Pt, wobble: number, bow: number, steps = 10): Pt[] {
  const [x0, y0] = a;
  const [x1, y1] = b;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal, so the bow pushes perpendicular to the stroke.
  const nx = -dy / len;
  const ny = dx / len;
  const arc = (rand() - 0.5) * bow;

  const points: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = Math.sin(t * Math.PI);
    const off = arc * ease + (rand() - 0.5) * wobble * ease;
    points.push([x0 + dx * t + nx * off, y0 + dy * t + ny * off]);
  }
  return points;
}

/** An arc of a jittered ellipse. Sweeps past its own start so it never closes cleanly. */
function arc(
  rand: () => number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  sweep: number,
  wobble: number,
  steps = 20
): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = from + sweep * t;
    const jitter = 1 + (rand() - 0.5) * wobble;
    points.push([cx + Math.cos(angle) * rx * jitter, cy + Math.sin(angle) * ry * jitter]);
  }
  return points;
}

/**
 * Two passes per mark. Drawing the shape twice, each pass wobbling
 * differently, is the single thing that separates "hand-drawn" from "wonky
 * vector" — it reads as a pen going back over its own line.
 */
export function sketchPaths(type: SketchType, seed: number): string[] {
  const rand = rng(seed);

  switch (type) {
    case 'underline':
      // Bow stays small here. The box is stretched to whatever it underlines,
      // so on a long heading a generous bow becomes a slow arc, and two
      // independent arcs drift apart into a visible gap rather than reading
      // as one pen going over its own line twice.
      return [
        smooth(stroke(rand, [3, 55], [97, 52], 9, 11)),
        smooth(stroke(rand, [6, 69], [95, 66], 11, 13)),
      ];

    case 'strike':
      return [smooth(stroke(rand, [2, 50], [98, 50], 10, 14))];

    case 'circle':
      // Overshoot past the start so the ring does not close cleanly, but not
      // so far that it trails a whisker off the side of the word.
      return [
        smooth(arc(rand, 50, 50, 46, 42, -0.3, Math.PI * 2 + 0.16, 0.08)),
        smooth(arc(rand, 50, 50, 44, 40, 0.3, Math.PI * 2 + 0.1, 0.1)),
      ];

    case 'bracket':
      return [
        smooth([
          ...stroke(rand, [22, 4], [7, 12], 8, 10, 3),
          ...stroke(rand, [7, 14], [7, 86], 7, 12, 8),
          ...stroke(rand, [7, 88], [22, 96], 8, 10, 3),
        ]),
        smooth([
          ...stroke(rand, [78, 4], [93, 12], 8, 10, 3),
          ...stroke(rand, [93, 14], [93, 86], 7, 12, 8),
          ...stroke(rand, [93, 88], [78, 96], 8, 10, 3),
        ]),
      ];

    case 'box':
      return [
        smooth([
          ...stroke(rand, [4, 8], [96, 5], 6, 9, 6),
          ...stroke(rand, [96, 6], [95, 94], 6, 9, 5),
          ...stroke(rand, [95, 94], [5, 96], 6, 9, 6),
          ...stroke(rand, [5, 96], [4, 10], 6, 9, 5),
        ]),
      ];
  }
}
