// Stage 3 — Intermediate Representation (IR) schema.
//
// The IR is a compact, framework-agnostic tree that sits between the raw Figma
// node tree and generated code. Everything the deterministic pipeline knows —
// layout (as flex, not coordinates), resolved tokens, text, assets, component
// bindings — lives here. Codegen (Stage 6) reads ONLY the IR, never raw Figma
// JSON. That's what keeps generation reliable and lets us target React/Vue/etc.
//
// This file defines the shape + a factory (createNode) + a validator (validateNode).

/** High-level role of a node — drives how codegen renders it. */
export const ROLES = Object.freeze({
  CONTAINER: 'container', // frame/group/component with children
  TEXT: 'text', // text node
  IMAGE: 'image', // raster image fill
  VECTOR: 'vector', // icon / vector → SVG asset
  SHAPE: 'shape', // rectangle/ellipse with only fills/strokes
  COMPONENT: 'component', // instance bound to a real code component
});

/** Layout mode of a container. */
export const LAYOUT = Object.freeze({
  FLEX: 'flex', // from Figma Auto Layout (HORIZONTAL / VERTICAL)
  GRID: 'grid', // from Figma Grid Auto Layout (layoutMode: 'GRID')
  ABSOLUTE: 'absolute', // no Auto Layout → children positioned by coords
  BLOCK: 'block', // leaf / normal flow
});

/**
 * @typedef {Object} Box   Geometry. `x`/`y` are RELATIVE to the parent (px).
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} Layout
 * @property {'flex'|'grid'|'absolute'|'block'} mode
 * @property {'row'|'column'} [direction]        Flex only.
 * @property {number} [gap]                       Flex gap (px) — from itemSpacing.
 * @property {number} [counterGap]                Wrapped flex: spacing between tracks (counterAxisSpacing).
 * @property {'space-between'} [alignContent]     Wrapped flex: counterAxisAlignContent.
 * @property {string} [columns]                   Grid: CSS grid-template-columns.
 * @property {string} [rows]                      Grid: CSS grid-template-rows.
 * @property {number} [columnGap]                 Grid: gridColumnGap (px).
 * @property {number} [rowGap]                    Grid: gridRowGap (px).
 * @property {string} [gridColumn]                Grid child: CSS grid-column.
 * @property {string} [gridRow]                   Grid child: CSS grid-row.
 * @property {'start'|'center'|'end'} [justifySelf]  Grid child: gridChildHorizontalAlign.
 * @property {{top:number,right:number,bottom:number,left:number}} [padding]
 * @property {'flex-start'|'center'|'flex-end'|'space-between'|'space-around'} [justify]
 * @property {'flex-start'|'center'|'flex-end'|'stretch'|'baseline'} [align]
 * @property {'nowrap'|'wrap'} [wrap]
 * @property {number} [grow]                      Child flex-grow (0|1).
 * @property {'auto'|'stretch'|'center'|'flex-start'|'flex-end'} [alignSelf]
 * @property {'static'|'absolute'} [position]     'absolute' escapes parent flow.
 * @property {'fixed'|'hug'|'fill'} [widthMode]   Figma sizing intent (Stage 8 responsiveness).
 * @property {'fixed'|'hug'|'fill'} [heightMode]  Figma sizing intent (Stage 8 responsiveness).
 */

/**
 * @typedef {Object} Style
 * @property {string} [background]     Solid background COLOR (bottom-most solid paint).
 * @property {string[]} [backgroundLayers]  Gradient/overlay layers, topmost first (CSS order).
 * @property {string} [color]          Text color (on text nodes).
 * @property {number} [opacity]
 * @property {number} [rotation]       Degrees, clockwise, about the element's centre.
 * @property {boolean} [mirrored]      Node is flipped (negative-determinant transform);
 *   applies as scaleY(-1) BEFORE the rotation.
 * @property {string} [blendMode]      CSS mix-blend-mode.
 * @property {number|number[]|string} [borderRadius]  Single value, [tl,tr,br,bl], or '50%' (ELLIPSE).
 * @property {string} [border]         e.g. "1px solid #e5e7eb".
 * @property {number} [borderWidth]
 * @property {string} [borderColor]
 * @property {'solid'|'dashed'} [borderStyle]
 * @property {{top:number,right:number,bottom:number,left:number}} [borderSides]  Per-side widths.
 * @property {'inside'|'center'|'outside'} [strokeAlign]
 * @property {string} [boxShadow]      One or more shadows, comma separated.
 * @property {string} [filter]         e.g. "blur(4px)" from a LAYER_BLUR effect.
 * @property {string} [backdropFilter] e.g. "blur(12px)" from a BACKGROUND_BLUR effect.
 * @property {'hidden'|'visible'} [overflow]
 * @property {string} [imageFill]     Figma imageRef of this node's image fill.
 */

/**
 * @typedef {Object} TextStyle
 * @property {string} content
 * @property {string} [fontFamily]
 * @property {number} [fontWeight]
 * @property {number} [fontSize]
 * @property {number} [lineHeight]     px
 * @property {number} [letterSpacing]  px
 * @property {'left'|'center'|'right'|'justify'} [align]
 * @property {'none'|'uppercase'|'lowercase'|'capitalize'} [textTransform]
 * @property {'none'|'underline'|'line-through'} [textDecoration]
 * @property {'top'|'center'|'bottom'} [verticalAlign]  Figma textAlignVertical.
 * @property {'italic'} [fontStyle]
 * @property {Array<{text:string,style:Object}>|null} [runs]  Mixed inline styles, if any.
 * @property {'ellipsis'} [truncation]  Figma textTruncation: ENDING.
 * @property {number} [maxLines]
 * @property {string} [autoResize]    Figma textAutoResize; WIDTH_AND_HEIGHT => never wrapped.
 * @property {string} [leadingTrim]   Figma leadingTrim; CAP_HEIGHT/BOTH collapse the line box.
 */

/**
 * @typedef {Object} IRNode
 * @property {string} id
 * @property {string} name
 * @property {string} role                       One of ROLES.
 * @property {Box} box
 * @property {Layout} layout
 * @property {Style} style
 * @property {TextStyle|null} text
 * @property {Object<string,string>} tokens      prop → token name (resolved from boundVariables).
 * @property {{key:string,name:string,props?:Object}|null} component   For instances.
 * @property {{type:'svg'|'image',ref:string}|null} asset
 * @property {string[]} warnings                 Design features with no faithful CSS equivalent.
 * @property {IRNode[]} children
 */

/**
 * Create an IR node with safe defaults.
 * @param {Partial<IRNode>} partial
 * @returns {IRNode}
 */
export function createNode(partial = {}) {
  return {
    id: partial.id ?? '',
    name: partial.name ?? '',
    role: partial.role ?? ROLES.CONTAINER,
    box: partial.box ?? { x: 0, y: 0, width: 0, height: 0 },
    layout: partial.layout ?? { mode: LAYOUT.BLOCK },
    style: partial.style ?? {},
    text: partial.text ?? null,
    tokens: partial.tokens ?? {},
    component: partial.component ?? null,
    asset: partial.asset ?? null,
    warnings: partial.warnings ?? [],
    children: partial.children ?? [],
  };
}

/**
 * Validate an IR node tree. Returns an array of human-readable problems
 * (empty = valid). Use in tests / after conversion to catch drift.
 * @param {IRNode} node
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateNode(node, path = 'root') {
  const errs = [];
  const roleValues = Object.values(ROLES);
  const layoutValues = Object.values(LAYOUT);

  if (!node || typeof node !== 'object') {
    return [`${path}: node is not an object`];
  }
  if (!node.id) errs.push(`${path}: missing id`);
  if (!roleValues.includes(node.role)) errs.push(`${path}: invalid role "${node.role}"`);
  if (!node.box || typeof node.box.width !== 'number') errs.push(`${path}: invalid box`);
  if (!node.layout || !layoutValues.includes(node.layout.mode)) {
    errs.push(`${path}: invalid layout.mode`);
  }
  if (node.role === ROLES.TEXT && (!node.text || typeof node.text.content !== 'string')) {
    errs.push(`${path}: text node missing text.content`);
  }
  if (!Array.isArray(node.children)) {
    errs.push(`${path}: children is not an array`);
  } else {
    node.children.forEach((c, i) => errs.push(...validateNode(c, `${path}.${node.name || i}`)));
  }
  return errs;
}
