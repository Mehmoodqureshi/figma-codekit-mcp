// Stage 2 — Auto Layout → Flexbox (deterministic, no LLM).
//
// This is the single biggest lever against the research-proven failure mode:
// models hardcoding absolute x/y coordinates. Figma Auto Layout maps almost 1:1
// to flexbox, so we compute the flex layout in code and hand codegen a clean
// `layout` object — the model never has to guess.
//
// Figma layout fields (REST API / Plugin API):
//   layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
//   primaryAxisAlignItems: 'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN'
//   counterAxisAlignItems: 'MIN'|'CENTER'|'MAX'|'BASELINE'
//   itemSpacing, paddingLeft/Right/Top/Bottom
//   layoutWrap: 'NO_WRAP' | 'WRAP'
// Per-child:
//   layoutGrow: 0|1, layoutAlign: 'STRETCH'|'INHERIT'|..., layoutPositioning: 'AUTO'|'ABSOLUTE'
// Grid Auto Layout adds, on the container:
//   gridColumnCount/gridRowCount, gridColumnGap/gridRowGap,
//   gridColumnsSizing/gridRowsSizing (already CSS track syntax)
// and per-child:
//   gridColumnAnchorIndex/gridRowAnchorIndex (0-based), gridColumnSpan/gridRowSpan,
//   gridChildHorizontalAlign/gridChildVerticalAlign: 'AUTO'|'MIN'|'CENTER'|'MAX'

import { LAYOUT } from './schema.js';

const PRIMARY_TO_JUSTIFY = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
};

const COUNTER_TO_ALIGN = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
};

const CHILD_ALIGN_SELF = {
  STRETCH: 'stretch',
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
};

// Grid uses the CSS Box Alignment keywords, not the flexbox ones. AUTO is
// deliberately absent: it means "inherit the container's rule", which is what
// omitting the declaration already does.
const GRID_SELF_ALIGN = { MIN: 'start', CENTER: 'center', MAX: 'end' };

/**
 * Figma hands us `gridColumnsSizing` / `gridRowsSizing` already in CSS track
 * syntax ("repeat(3,minmax(0,1fr))", "267.55px"), which is a gift — but it is
 * also a string from a file we did not write, going straight into a stylesheet.
 * Anything that could close a declaration or open an at-rule is rejected and the
 * caller falls back to an even track split.
 */
function safeTrackList(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  return /^[\w\s.,()%/-]+$/.test(v) ? v : undefined;
}

/**
 * Compute the container-level `layout` from a raw Figma frame node.
 * @param {Object} figmaNode
 * @returns {import('./schema.js').Layout}
 */
export function computeContainerLayout(figmaNode) {
  const mode = figmaNode.layoutMode;

  // No Auto Layout. A leaf (no children) is just block flow; a container with
  // children but no Auto Layout positions those children absolutely by coords.
  if (!mode || mode === 'NONE') {
    const hasChildren = Array.isArray(figmaNode.children) && figmaNode.children.length > 0;
    return { mode: hasChildren ? LAYOUT.ABSOLUTE : LAYOUT.BLOCK };
  }

  const padding = {
    top: figmaNode.paddingTop ?? 0,
    right: figmaNode.paddingRight ?? 0,
    bottom: figmaNode.paddingBottom ?? 0,
    left: figmaNode.paddingLeft ?? 0,
  };

  // Figma's Grid Auto Layout. Figma reports the track lists in CSS syntax and
  // the children carry explicit row/column anchors, so this maps across almost
  // literally — which is worth doing rather than approximating with flex, since
  // a grid is exactly the case flex gets wrong.
  if (mode === 'GRID') {
    const cols = figmaNode.gridColumnCount ?? 1;
    return {
      mode: LAYOUT.GRID,
      columns: safeTrackList(figmaNode.gridColumnsSizing) || `repeat(${cols}, minmax(0, 1fr))`,
      rows: safeTrackList(figmaNode.gridRowsSizing),
      columnGap: figmaNode.gridColumnGap ?? 0,
      rowGap: figmaNode.gridRowGap ?? 0,
      padding,
      // CSS grid stretches items to their track by default; Figma does not —
      // a HUG child keeps its own height and overflows a shorter track. Start
      // preserves that, and a FILL child gets align-self:stretch back from its
      // sizing mode.
      align: 'start',
    };
  }

  // An unrecognised mode is a NEW Figma layout feature, not a vertical stack.
  // Falling through to the flex branch would silently label it `column` and
  // stack a row of cards — the failure this whole branch exists to prevent.
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') {
    const hasChildren = Array.isArray(figmaNode.children) && figmaNode.children.length > 0;
    return { mode: hasChildren ? LAYOUT.ABSOLUTE : LAYOUT.BLOCK, unknownLayoutMode: mode };
  }

  return {
    mode: LAYOUT.FLEX,
    direction: mode === 'HORIZONTAL' ? 'row' : 'column',
    gap: figmaNode.itemSpacing ?? 0,
    padding,
    justify: PRIMARY_TO_JUSTIFY[figmaNode.primaryAxisAlignItems] ?? 'flex-start',
    align: COUNTER_TO_ALIGN[figmaNode.counterAxisAlignItems] ?? 'flex-start',
    wrap: figmaNode.layoutWrap === 'WRAP' ? 'wrap' : 'nowrap',
    // Wrapped Auto Layout has TWO spacings: itemSpacing between items in a
    // track, counterAxisSpacing between the tracks themselves. CSS `gap` sets
    // both at once, so emitting only itemSpacing pushes every wrapped track
    // away by the item spacing — a 1440px "space between" row wraps its second
    // track 1440px down, out of the frame. Unset means Figma never split them.
    ...(figmaNode.layoutWrap === 'WRAP'
      ? {
          counterGap: figmaNode.counterAxisSpacing ?? figmaNode.itemSpacing ?? 0,
          ...(ALIGN_CONTENT[figmaNode.counterAxisAlignContent]
            ? { alignContent: ALIGN_CONTENT[figmaNode.counterAxisAlignContent] }
            : {}),
        }
      : {}),
  };
}

/** counterAxisAlignContent (wrapped tracks) → CSS align-content. AUTO = packed at start. */
const ALIGN_CONTENT = { SPACE_BETWEEN: 'space-between' };

const SIZING = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' };

/**
 * Capture Figma's per-axis sizing intent — the signal Stage 8 uses to make the
 * layout responsive. `layoutSizingHorizontal`/`layoutSizingVertical` are FIXED
 * (keep px), HUG (size to content), or FILL (stretch to fill the parent).
 * Falls back to inference from grow/align/sizing-mode for older payloads.
 * @param {Object} figmaNode
 * @returns {{widthMode:'fixed'|'hug'|'fill', heightMode:'fixed'|'hug'|'fill'}}
 */
export function computeSizing(figmaNode) {
  let widthMode = SIZING[figmaNode.layoutSizingHorizontal];
  let heightMode = SIZING[figmaNode.layoutSizingVertical];

  // Fallback inference when the modern fields are absent.
  if (!widthMode || !heightMode) {
    const mode = figmaNode.layoutMode;
    // A child that grows fills its parent's main axis.
    if (figmaNode.layoutGrow === 1) {
      // Main axis depends on the PARENT's direction, which we don't have here;
      // grow is surfaced separately as layout.grow, so leave modes at fixed and
      // let the codegen honor grow. This keeps the fallback conservative.
    }
    // An Auto-Layout container that hugs sizes to its children. GRID is excluded:
    // its primary/counter axis sizing modes do not describe a single direction.
    if (mode === 'HORIZONTAL' || mode === 'VERTICAL') {
      if (figmaNode.primaryAxisSizingMode === 'AUTO') {
        if (mode === 'HORIZONTAL') widthMode ||= 'hug';
        else heightMode ||= 'hug';
      }
      if (figmaNode.counterAxisSizingMode === 'AUTO') {
        if (mode === 'HORIZONTAL') heightMode ||= 'hug';
        else widthMode ||= 'hug';
      }
    }
  }

  return { widthMode: widthMode || 'fixed', heightMode: heightMode || 'fixed' };
}

/**
 * Compute child-level layout hints (flex-grow, align-self, absolute escape).
 * Merged onto the child's own layout by the converter.
 * @param {Object} childFigmaNode
 * @param {import('./schema.js').Layout} parentLayout
 * @returns {Partial<import('./schema.js').Layout>}
 */
export function computeChildLayout(childFigmaNode, parentLayout) {
  const out = {};

  // A child explicitly marked ABSOLUTE escapes the flex flow.
  if (childFigmaNode.layoutPositioning === 'ABSOLUTE') {
    out.position = 'absolute';
    return out;
  }

  // Inside a grid parent, the child carries its own cell. Figma's anchors are
  // 0-based; CSS grid lines are 1-based.
  if (parentLayout?.mode === LAYOUT.GRID) {
    out.position = 'static';
    const col = childFigmaNode.gridColumnAnchorIndex;
    const row = childFigmaNode.gridRowAnchorIndex;
    const colSpan = childFigmaNode.gridColumnSpan ?? 1;
    const rowSpan = childFigmaNode.gridRowSpan ?? 1;
    if (Number.isInteger(col)) {
      out.gridColumn = colSpan > 1 ? `${col + 1} / span ${colSpan}` : String(col + 1);
    }
    if (Number.isInteger(row)) {
      out.gridRow = rowSpan > 1 ? `${row + 1} / span ${rowSpan}` : String(row + 1);
    }
    const j = GRID_SELF_ALIGN[childFigmaNode.gridChildHorizontalAlign];
    const a = GRID_SELF_ALIGN[childFigmaNode.gridChildVerticalAlign];
    if (j) out.justifySelf = j;
    if (a) out.alignSelf = a;
    return out;
  }

  // Inside a flex parent, translate grow/stretch.
  if (parentLayout?.mode === LAYOUT.FLEX) {
    out.position = 'static';
    if (childFigmaNode.layoutGrow === 1) out.grow = 1;
    const self = CHILD_ALIGN_SELF[childFigmaNode.layoutAlign];
    if (self) out.alignSelf = self;
  } else if (parentLayout?.mode === LAYOUT.ABSOLUTE) {
    // In an absolute parent, every child is absolutely placed by its box.
    out.position = 'absolute';
  }

  return out;
}
