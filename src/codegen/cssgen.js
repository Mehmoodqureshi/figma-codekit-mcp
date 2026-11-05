// Stage 6 — CSS generation from IR (shared by the HTML and React emitters).
//
// The IR already did the hard part: layout is flex (not coordinates), styles and
// tokens are resolved. This module just serializes an IR node's `layout` + `style`
// + `text` into CSS declarations. Deterministic, no LLM.
//
// Sizing philosophy: emit explicit width/height so the FIRST render is close to
// exact (that's what the Stage 7 verify loop needs to start from). Stage 8
// (responsiveness pass) relaxes fixed sizes into flex/relative units afterward.

import { ROLES } from '../ir/schema.js';

// Sub-pixel values are kept. Figma places things on fractional coordinates all
// the time, and rounding every node to a whole pixel accumulates down a long
// flex column until the bottom of the frame has visibly drifted. Trailing zeros
// are trimmed so the common whole-pixel case still reads as `16px`.
const px = (n) => `${Number(Number(n).toFixed(2))}px`;

/**
 * A token name → a syntactically valid CSS custom property.
 *
 * Only `/` and `.` used to be replaced, which is fine for a tidy name like
 * 'color/surface/card' but not for the raw ids Figma returns when the Variables
 * API is unavailable: 'VariableID:60c6c3…/113:705'. A custom property name must
 * be an identifier, and `:` is not an identifier character — so `var(--Variable
 * ID:60c6…)` is a PARSE error, and the browser drops the whole declaration
 * silently. On the frame this was found on, every token-bound `gap` vanished and
 * three testimonial columns lost their internal spacing with no warning
 * anywhere. Anything outside [A-Za-z0-9_-] is collapsed to a dash.
 */
function tokenVarName(name) {
  return `--${String(name).replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

/**
 * 'color/surface/card' → var(--color-surface-card, <fallback>).
 * The fallback is the exact value resolved from Figma, so the FIRST render is
 * correct even before the real token file is wired — then the token wins once
 * defined. Don't emit `--x: initial` in :root or it would shadow this fallback.
 */
export function tokenToVar(name, fallback) {
  const varName = tokenVarName(name);
  return fallback != null ? `var(${varName}, ${fallback})` : `var(${varName})`;
}

/** Collect every token referenced in the tree into :root custom properties. */
export function collectTokenVars(node, acc = new Map()) {
  for (const tokenName of Object.values(node.tokens || {})) {
    const varName = tokenVarName(tokenName);
    if (!acc.has(varName)) acc.set(varName, ''); // value filled from real token file
  }
  (node.children || []).forEach((c) => collectTokenVars(c, acc));
  return acc;
}

function radiusToCss(r) {
  if (typeof r === 'string') return r; // e.g. '50%' from an ELLIPSE
  return Array.isArray(r) ? r.map(px).join(' ') : px(r);
}

/**
 * Stage 8 — map a Figma sizing mode to CSS for one axis.
 * FILL → grow (main axis) or stretch/100% (cross axis); HUG → auto/fit-content;
 * FIXED → keep px, but the root becomes width:100% + max-width so it's responsive.
 */
function axisRule(dim, mode, sizePx, { isMain, isRoot, isText }) {
  if (mode === 'fill') {
    if (isMain) return { flex: '1 1 0%' };
    return dim === 'width' ? { width: '100%' } : { 'align-self': 'stretch' };
  }
  if (mode === 'hug') {
    return dim === 'width' ? { width: 'fit-content' } : {}; // height: auto
  }
  // fixed
  if (dim === 'width') {
    if (isRoot) {
      return { width: '100%', 'max-width': px(sizePx), 'margin-left': 'auto', 'margin-right': 'auto' };
    }
    return { width: px(sizePx) };
  }
  // height, fixed
  if (isText) return {}; // never pin a text node's height — let it wrap
  if (isRoot) return { 'min-height': px(sizePx) }; // allow the frame to grow
  return { height: px(sizePx) };
}

/** Apply sizing to the declaration map — exact px, or responsive relative units. */
function applySizing(d, node, { responsive, parentLayout }) {
  const L = node.layout;
  const box = node.box;
  if (!responsive) {
    // Exact-first: fixed px everywhere (except grow → flex, text height → auto).
    if (L.grow) d.flex = '1 1 0%';
    else d.width = px(box.width);
    if (node.role !== ROLES.TEXT) d.height = px(box.height);
    return;
  }
  const isRoot = !parentLayout;
  const parentDir = parentLayout?.mode === 'flex' ? parentLayout.direction : null;
  const isText = node.role === ROLES.TEXT;
  const wMode = L.widthMode || 'fixed';
  const hMode = L.heightMode || 'fixed';
  Object.assign(d, axisRule('width', wMode, box.width, { isMain: parentDir === 'row', isRoot, isText }));
  Object.assign(d, axisRule('height', hMode, box.height, { isMain: parentDir === 'column', isRoot, isText }));
}

/**
 * Assemble the background stack.
 *
 * CSS has exactly one background-color slot but any number of background-image
 * layers, and it paints the FIRST image layer on top. The IR hands over gradient
 * layers already in that order; the exported bitmap goes underneath them, which
 * is what makes the standard hero — photo, dark scrim over it, white text —
 * come out right instead of dropping the scrim and leaving the text on a bright
 * photo.
 *
 * Each layer needs its own size/position/repeat entry, or the list is reused
 * cyclically and the bitmap inherits a gradient's sizing.
 */
function applyBackground(d, node, opts) {
  const S = node.style;
  if (S.background) {
    d['background-color'] = node.tokens.fills ? tokenToVar(node.tokens.fills, S.background) : S.background;
  }

  const layers = [];
  const sizes = [];
  const positions = [];
  const repeats = [];

  for (const layer of S.backgroundLayers || []) {
    layers.push(layer);
    sizes.push('auto');
    positions.push('0% 0%');
    repeats.push('no-repeat');
  }

  // An image fill on a frame (hero/card photo) → CSS background layer, if exported.
  // Skipped when an <img> already carries it (role IMAGE, uncropped): these are
  // data URIs, so emitting both would duplicate the whole bitmap in the output.
  const cropped = S.imageFit?.fit === 'crop';
  if (S.imageFill && opts.assets?.[node.id] && (node.role !== ROLES.IMAGE || cropped)) {
    layers.push(`url("${opts.assets[node.id]}")`);
    if (cropped) {
      sizes.push(`${S.imageFit.sizeX}% ${S.imageFit.sizeY}%`);
      positions.push(`${S.imageFit.posX}% ${S.imageFit.posY}%`);
      repeats.push('no-repeat');
    } else if (S.imageFit?.fit === 'repeat') {
      sizes.push('auto');
      positions.push('0% 0%');
      repeats.push('repeat');
    } else {
      sizes.push(S.imageFit?.fit === 'contain' ? 'contain' : 'cover');
      positions.push('center');
      repeats.push('no-repeat');
    }
  }

  // A paint-level opacity has no CSS equivalent on a single background layer, so
  // it becomes element opacity — correct for the decorative leaf images this
  // shows up on (a hero photo sunk into the frame colour), but it would fade a
  // container's children too, so a node with content keeps full opacity and
  // says so instead of quietly dimming its own text.
  const fillAlpha = S.imageFit?.opacity;
  if (fillAlpha != null) {
    if ((node.children || []).length === 0) {
      const own = typeof S.opacity === 'number' ? S.opacity : 1;
      d.opacity = String(Number((own * fillAlpha).toFixed(4)));
    } else {
      node.warnings?.push?.(
        `IMAGE_FILL_OPACITY: ${fillAlpha} on a node with children — not applied, it would fade them too`
      );
    }
  }

  if (layers.length) {
    d['background-image'] = layers.join(', ');
    d['background-size'] = sizes.join(', ');
    d['background-position'] = positions.join(', ');
    d['background-repeat'] = repeats.join(', ');
  }
}

/**
 * Borders.
 *
 * Only an INSIDE stroke maps to `border` — that's the one CSS models the same
 * way. CENTER/OUTSIDE use `outline`, which paints beyond the border box without
 * consuming content space; a negative offset pulls a centred stroke back so it
 * straddles the edge the way Figma draws it.
 *
 * Per-side widths always use `border`, because `outline` has no per-side form.
 * This is the case that matters most in practice: every divider, underlined tab
 * and table row in a design is a single-sided stroke, and collapsing that to a
 * uniform border draws a box around something that should have one line.
 */
function applyBorder(d, S) {
  if (!S.border) return;
  const sides = S.borderSides;
  const mixed = sides && new Set(Object.values(sides)).size > 1;

  if (mixed) {
    d['border-style'] = S.borderStyle || 'solid';
    d['border-color'] = S.borderColor;
    d['border-width'] = `${px(sides.top)} ${px(sides.right)} ${px(sides.bottom)} ${px(sides.left)}`;
    return;
  }
  if ((S.strokeAlign || 'inside') === 'inside') {
    d.border = S.border;
    return;
  }
  d.outline = S.border;
  if (S.strokeAlign === 'center') d['outline-offset'] = `-${(S.borderWidth || 0) / 2}px`;
}

/**
 * Text.
 *
 * Vertical alignment is the one that shows up everywhere. Figma centres text in
 * its box by default for hand-placed layers, and CSS puts it at the top — so
 * every button label and badge sits a few pixels high. Honouring it needs the
 * box to actually have a height, which is why a fixed-size text node gets a
 * `min-height`: enough to position against, but still free to grow if our font
 * metrics wrap a line the design didn't.
 */
function applyText(d, node, opts) {
  const t = node.text;
  if (!t) return;

  if (t.fontFamily) d['font-family'] = `'${t.fontFamily}', sans-serif`;
  if (t.fontSize) d['font-size'] = px(t.fontSize);
  if (t.fontWeight) d['font-weight'] = String(t.fontWeight);
  if (t.fontStyle) d['font-style'] = t.fontStyle;
  if (t.lineHeight) d['line-height'] = px(t.lineHeight);
  if (t.letterSpacing) d['letter-spacing'] = px(t.letterSpacing);
  if (t.align && t.align !== 'left') d['text-align'] = t.align;
  if (t.textTransform && t.textTransform !== 'none') d['text-transform'] = t.textTransform;
  if (t.textDecoration && t.textDecoration !== 'none') d['text-decoration'] = t.textDecoration;
  if (t.color) d.color = t.color;

  // Figma sized this box to its text, so it never wrapped in the design. Left
  // to wrap, it reflows the moment our font metrics differ by a hair — and
  // they always do, because the webfont is not the one Figma measured with.
  // Only safe in exact mode; the responsive pass wants these free to wrap.
  const hugsBoth = t.autoResize === 'WIDTH_AND_HEIGHT';
  if (hugsBoth && !opts.responsive) d['white-space'] = 'nowrap';

  // A fixed-size text box can be aligned within its height; a hugging one can't
  // (its height IS the text), so there is nothing to align against.
  const fixedHeight = !t.autoResize || t.autoResize === 'NONE';
  if (fixedHeight && !opts.responsive) {
    d['min-height'] = px(node.box.height);
    if (t.verticalAlign === 'center' || t.verticalAlign === 'bottom') {
      d.display = 'flex';
      d['flex-direction'] = 'column';
      d['justify-content'] = t.verticalAlign === 'center' ? 'center' : 'flex-end';
    }
  }

  if (t.maxLines && t.maxLines > 1) {
    d.display = '-webkit-box';
    d['-webkit-line-clamp'] = String(t.maxLines);
    d['-webkit-box-orient'] = 'vertical';
    d.overflow = 'hidden';
  } else if (t.truncation === 'ellipsis') {
    d.overflow = 'hidden';
    d['text-overflow'] = 'ellipsis';
    d['white-space'] = 'nowrap';
  }
}

/**
 * Build the CSS declaration map for one IR node.
 * @param {import('../ir/schema.js').IRNode} node
 * @param {Object} [opts]
 * @param {boolean} [opts.responsive=false]   Stage 8: emit relative units instead of fixed px.
 * @param {import('../ir/schema.js').Layout} [opts.parentLayout]  Parent's layout (for main/cross-axis).
 * @param {Object<string,string>} [opts.assets]  node id → data URI.
 * @returns {Object<string,string>}  kebab-case CSS property → value
 */
export function cssDeclarations(node, opts = {}) {
  const d = {};
  const L = node.layout;
  const S = node.style;
  const box = node.box;

  // --- self placement ---------------------------------------------------
  if (L.position === 'absolute') {
    d.position = 'absolute';
    d.left = px(box.x);
    d.top = px(box.y);
  }
  if (L.alignSelf) d['align-self'] = L.alignSelf;
  if (L.justifySelf) d['justify-self'] = L.justifySelf;
  if (L.gridColumn) d['grid-column'] = L.gridColumn;
  if (L.gridRow) d['grid-row'] = L.gridRow;

  // --- how this node lays out its children ------------------------------
  if (L.mode === 'flex') {
    d.display = 'flex';
    d['flex-direction'] = L.direction;
    const mainGap = L.gap
      ? node.tokens.itemSpacing
        ? tokenToVar(node.tokens.itemSpacing, px(L.gap))
        : px(L.gap)
      : null;
    if (L.wrap === 'wrap' && L.counterGap !== undefined && L.counterGap !== L.gap) {
      // Split the two spacings: along the direction of travel it is the item
      // spacing, between wrapped tracks it is counterAxisSpacing.
      const [along, across] = L.direction === 'row' ? ['column-gap', 'row-gap'] : ['row-gap', 'column-gap'];
      if (mainGap) d[along] = mainGap;
      if (L.counterGap) d[across] = px(L.counterGap);
    } else if (mainGap) d.gap = mainGap;
    if (L.wrap === 'wrap' && L.alignContent) d['align-content'] = L.alignContent;
    if (L.padding) {
      d.padding = `${px(L.padding.top)} ${px(L.padding.right)} ${px(L.padding.bottom)} ${px(L.padding.left)}`;
    }
    d['justify-content'] = L.justify;
    d['align-items'] = L.align;
    if (L.wrap === 'wrap') d['flex-wrap'] = 'wrap';
  } else if (L.mode === 'grid') {
    // Figma's own track lists go straight through — they are already CSS syntax
    // and are validated in autolayout.js before reaching here.
    d.display = 'grid';
    if (L.columns) d['grid-template-columns'] = L.columns;
    if (L.rows) d['grid-template-rows'] = L.rows;
    if (L.columnGap) d['column-gap'] = px(L.columnGap);
    if (L.rowGap) d['row-gap'] = px(L.rowGap);
    if (L.padding) {
      d.padding = `${px(L.padding.top)} ${px(L.padding.right)} ${px(L.padding.bottom)} ${px(L.padding.left)}`;
    }
    if (L.align) d['align-items'] = L.align;
  } else if (L.mode === 'absolute') {
    // Establish a containing block for absolutely-positioned children.
    if (!d.position) d.position = 'relative';
  }

  // --- sizing (exact px, or Stage 8 responsive relative units) ----------
  applySizing(d, node, opts);

  // --- appearance -------------------------------------------------------
  applyBackground(d, node, opts);
  if (S.color) d.color = S.color;
  if (typeof S.opacity === 'number') d.opacity = String(S.opacity);
  if (S.borderRadius !== undefined) d['border-radius'] = radiusToCss(S.borderRadius);
  applyBorder(d, S);
  if (S.boxShadow) d['box-shadow'] = S.boxShadow;
  if (S.filter) d.filter = S.filter;
  if (S.backdropFilter) d['backdrop-filter'] = S.backdropFilter;
  if (S.blendMode) d['mix-blend-mode'] = S.blendMode;
  if (S.overflow) d.overflow = S.overflow;
  // The IR places a rotated node concentric with its bounding box, so the
  // default centre transform-origin is exactly the right pivot. A mirrored node
  // is R(theta) * diag(1, -1) — the flip applies first, which in CSS means it
  // goes last, to the right of the rotate.
  if (S.rotation || S.mirrored) {
    const parts = [];
    if (S.rotation) parts.push(`rotate(${S.rotation}deg)`);
    if (S.mirrored) parts.push('scaleY(-1)');
    d.transform = parts.join(' ');
  }

  // --- text -------------------------------------------------------------
  if (node.role === ROLES.TEXT) applyText(d, node, opts);

  return d;
}

/** Serialize a declaration map to a CSS body string. */
export function declToString(d) {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
}

/** Minimal reset so box-sizing/margins don't fight the exact sizing above. */
export const RESET = `*{margin:0;box-sizing:border-box;} body{font-family:-apple-system,'Inter',Arial,sans-serif;}`;

/**
 * Stage 8, second half — the scaling shell for a design with NO Auto Layout.
 *
 * `axisRule` can only make a frame fluid when Figma told us the sizing intent
 * (FILL/HUG). A hand-placed canvas has none: every child is `position:absolute`
 * at a coordinate on a 1440px artboard, so relaxing the ROOT to `width:100%`
 * just means the children keep their 1440-canvas coordinates inside a narrower
 * box and the right-hand side is silently clipped by `overflow:hidden`. The
 * page doesn't reflow — it loses content, which is what browser zoom looks
 * like to a user.
 *
 * There is no honest reflow for those coordinates, so we scale instead: the
 * canvas stays exactly as designed and the whole thing is mapped to the
 * available width. Layout is unaffected by `transform`, so the shell's own
 * width/height are set to the SCALED box — otherwise the page would reserve
 * the full 1440x4096 and leave dead space below and a phantom scrollbar.
 *
 * Without JS this degrades to the unscaled canvas, i.e. exactly the old output.
 */
export function canvasFitCss(width, height) {
  return (
    `html{overflow-x:auto;}` +
    `.figma-canvas-fit{position:relative;width:100%;max-width:${px(width)};` +
    `height:${px(height)};margin:0 auto;overflow:hidden;}` +
    `.figma-canvas-fit>*{transform-origin:top left;transform:scale(var(--canvas-scale,1));}`
  );
}

/**
 * Below `minScale` we stop shrinking and let the page scroll horizontally —
 * past roughly half size the design is unreadable anyway, and a scrollbar is a
 * better failure than 6px type. The last applied scale is remembered so the
 * ResizeObserver can't oscillate against the vertical scrollbar appearing and
 * disappearing as the shell's height changes.
 */
export function canvasFitScript(width, height, minScale) {
  return (
    `(function(){var W=${width},H=${height},MIN=${minScale},last=-1;` +
    `var el=document.querySelector('.figma-canvas-fit');if(!el)return;` +
    `function fit(){var avail=document.documentElement.clientWidth;` +
    `var s=Math.min(1,Math.max(MIN,avail/W));s=Math.round(s*1e4)/1e4;` +
    `if(s===last)return;last=s;el.style.setProperty('--canvas-scale',s);` +
    `el.style.width=(W*s)+'px';el.style.maxWidth='none';el.style.height=(H*s)+'px';}` +
    `fit();addEventListener('resize',fit);` +
    `if(window.ResizeObserver)new ResizeObserver(fit).observe(document.documentElement);})();`
  );
}
