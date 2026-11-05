// Stage 7 — Element-bbox IoU: per-element layout verification.
//
// The pixel diff says "this region differs"; this says "the CTA button is
// missing / 40px too low." For each IR node it compares:
//   • expected box — the design position (accumulated from the IR tree)
//   • actual box   — where the element actually rendered (measured from the DOM
//                    via data-ir-id, frame-relative)
// and computes IoU. No match → missing. Low IoU → misplaced/mis-sized.
//
// True IoU (not the region-grid stand-in) because both boxes are known: the
// expected one from the IR, the actual one from the rendered element.

/**
 * The box a browser reports for a rotated element: getBoundingClientRect() is the
 * axis-aligned bounds of the TURNED shape, rotated about its centre (the CSS
 * default transform-origin). Comparing that against the unrotated design box
 * marks every rotated prop as misplaced even when it is drawn exactly right —
 * a 788x1440 image turned 90° is reported as 1440x788.
 */
export function rotatedBounds(x, y, w, h, deg) {
  if (!deg) return { x, y, w, h };
  const r = (Number(deg) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  return { x: x + w / 2 - bw / 2, y: y + h / 2 - bh / 2, w: bw, h: bh };
}

/**
 * Flatten an IR tree into absolute (frame-relative) expected boxes.
 * IR child boxes are relative to their parent, so we accumulate offsets.
 * @param {import('./ir/schema.js').IRNode} node
 * @returns {Array<{id,name,role,label,box:{x,y,w,h}}>}
 */
export function flattenExpectedBoxes(node, offsetX = 0, offsetY = 0, out = []) {
  const x = offsetX + node.box.x;
  const y = offsetY + node.box.y;
  out.push({
    id: node.id,
    name: node.name,
    role: node.role,
    label: node.text?.content || node.component?.name || node.name,
    box: rotatedBounds(x, y, node.box.width, node.box.height, node.style?.rotation),
  });
  for (const child of node.children || []) flattenExpectedBoxes(child, x, y, out);
  return out;
}

/** Intersection-over-union of two {x,y,w,h} boxes (0 = disjoint, 1 = identical). */
export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * @typedef {Object} ElementFinding
 * @property {string} id
 * @property {string} label
 * @property {string} role
 * @property {'ok'|'missing'|'misplaced'} status
 * @property {number} iou
 * @property {{x,y,w,h}} expected
 * @property {{x,y,w,h}|null} actual
 */

/**
 * Compare expected boxes to rendered boxes.
 * @param {ReturnType<typeof flattenExpectedBoxes>} expected
 * @param {Object<string,{x,y,w,h}|null>} rendered  id → measured box (or null if absent)
 * @param {Object} [opts]
 * @param {number} [opts.iouThreshold=0.6]   Below this (but present) = misplaced.
 * @returns {ElementFinding[]}  worst-first
 */
export function computeElementDiffs(expected, rendered, opts = {}) {
  const { iouThreshold = 0.6 } = opts;
  const findings = expected.map((e) => {
    const actual = rendered[e.id] || null;
    if (!actual || actual.w <= 0 || actual.h <= 0) {
      return { id: e.id, label: e.label, role: e.role, status: 'missing', iou: 0, expected: e.box, actual };
    }
    const score = iou(e.box, actual);
    return {
      id: e.id,
      label: e.label,
      role: e.role,
      status: score >= iouThreshold ? 'ok' : 'misplaced',
      iou: score,
      expected: e.box,
      actual,
    };
  });
  // Worst first: missing, then lowest IoU.
  return findings.sort((a, b) => {
    if (a.status === 'missing' && b.status !== 'missing') return -1;
    if (b.status === 'missing' && a.status !== 'missing') return 1;
    return a.iou - b.iou;
  });
}

/**
 * Turn element findings into a correction snippet for the model.
 * @param {ElementFinding[]} findings
 * @param {Object} [opts]
 * @param {string} [opts.rootId]      Skip the frame root (always matches).
 * @param {number} [opts.max=8]
 * @returns {string}  '' if nothing worth reporting
 */
export function buildElementCorrection(findings, opts = {}) {
  const { rootId, max = 8 } = opts;
  const problems = findings
    .filter((f) => f.status !== 'ok' && f.id !== rootId)
    .slice(0, max);
  if (problems.length === 0) return '';

  const b = (box) => (box ? `(x:${Math.round(box.x)} y:${Math.round(box.y)} w:${Math.round(box.w)} h:${Math.round(box.h)})` : 'not rendered');
  const lines = ['### Element-level check (bounding-box IoU vs the design)'];
  for (const f of problems) {
    if (f.status === 'missing') {
      lines.push(`- **MISSING** — "${f.label}" (${f.role}) expected at ${b(f.expected)} but not found in the render. Add it.`);
    } else {
      lines.push(
        `- **MISPLACED** — "${f.label}" (${f.role}) overlaps the design by only ${(f.iou * 100).toFixed(0)}% (IoU). ` +
          `Expected ${b(f.expected)}, rendered ${b(f.actual)}. Fix its position/size.`
      );
    }
  }
  return lines.join('\n');
}
