// Stage 6 helper — CSS declarations → Tailwind classes.
//
// The React emitter's inline style objects are exact but not what a Tailwind
// codebase wants to merge. This turns the same declaration map into classes:
// keyword values become idiomatic utilities (flex, items-center, absolute…),
// lengths become arbitrary-value utilities (w-[354px], top-[253px]), colours and
// fonts use the generated theme when tokens are on (text-c8960c, font-crimson-pro),
// and anything else becomes a Tailwind arbitrary property ([transform:rotate(-90deg)]),
// which is valid for any CSS property in Tailwind v3.4+ and v4.
//
// It is a mapping of the SAME declarations, so the Tailwind variant renders the
// same as the inline-style one — nothing is approximated to the nearest scale step.

import { colorTokenName } from './tokens.js';

const KEYWORDS = {
  display: { flex: 'flex', block: 'block', grid: 'grid', 'inline-flex': 'inline-flex', none: 'hidden', 'inline-block': 'inline-block' },
  'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  position: { absolute: 'absolute', relative: 'relative', fixed: 'fixed', sticky: 'sticky' },
  overflow: { hidden: 'overflow-hidden', visible: 'overflow-visible', auto: 'overflow-auto' },
  'box-sizing': { 'border-box': 'box-border', 'content-box': 'box-content' },
  'white-space': { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal', 'pre-wrap': 'whitespace-pre-wrap' },
  'text-align': { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'align-items': { center: 'items-center', 'flex-start': 'items-start', 'flex-end': 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' },
  'align-self': { center: 'self-center', 'flex-start': 'self-start', 'flex-end': 'self-end', stretch: 'self-stretch', auto: 'self-auto' },
  'justify-content': { center: 'justify-center', 'flex-start': 'justify-start', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' },
  'border-style': { solid: 'border-solid', dashed: 'border-dashed', dotted: 'border-dotted' },
  'object-fit': { cover: 'object-cover', contain: 'object-contain', fill: 'object-fill', none: 'object-none' },
};

const PREFIX = {
  width: 'w', height: 'h', 'min-width': 'min-w', 'max-width': 'max-w', 'min-height': 'min-h', 'max-height': 'max-h',
  left: 'left', top: 'top', right: 'right', bottom: 'bottom',
  gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x',
  'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl',
  'border-radius': 'rounded', opacity: 'opacity', 'z-index': 'z',
  'line-height': 'leading', 'letter-spacing': 'tracking', 'font-weight': 'font',
};

/** Escape a CSS value for use inside Tailwind brackets: spaces → _, literal _ → \_. */
const arb = (v) => String(v).trim().replace(/"/g, "'").replace(/_/g, '\\_').replace(/\s+/g, '_');

const isZero = (v) => /^0(px)?$/.test(String(v).trim());

/** "0px 0px 0px 0px" → p-0;  "10px 20px" → py/px. */
function paddingClasses(v) {
  const p = String(v).trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = p;
  if ([t, r, b, l].every(isZero)) return [];
  if (t === b && r === l) return t === r ? [`p-[${arb(t)}]`] : [`py-[${arb(t)}]`, `px-[${arb(r)}]`];
  return [['pt', t], ['pr', r], ['pb', b], ['pl', l]].filter(([, x]) => !isZero(x)).map(([k, x]) => `${k}-[${arb(x)}]`);
}

/**
 * Declaration map → { className, style }. Values that are too large or unsafe
 * for a class (a data: URI background) stay in `style`.
 * @param {Object<string,string|number>} decls  From cssDeclarations().
 * @param {{ colors?: Map<string,string>, fonts?: Map<string,string> }} [names]  Token names (generateTokenFiles().names).
 */
export function toTailwind(decls, names = {}) {
  const classes = [];
  const style = {};
  for (const [prop, raw] of Object.entries(decls)) {
    const v = String(raw).trim();
    if (v.includes('url(') && v.length > 200) {
      style[prop] = raw; // a data URI does not belong in a class name
      continue;
    }
    const kw = KEYWORDS[prop]?.[v];
    if (kw) {
      classes.push(kw);
      continue;
    }
    if (prop === 'padding') {
      classes.push(...paddingClasses(v));
      continue;
    }
    if (prop === 'color' || prop === 'background-color' || prop === 'border-color') {
      const util = prop === 'color' ? 'text' : prop === 'background-color' ? 'bg' : 'border';
      const key = v.toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3');
      const token = names.colors?.get(key);
      classes.push(token ? `${util}-${token}` : `${util}-[color:${arb(v)}]`);
      continue;
    }
    if (prop === 'font-family') {
      const fam = v.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      const token = names.fonts?.get(fam);
      classes.push(token ? `font-${token}` : `font-[${arb(v)}]`);
      continue;
    }
    if (prop === 'font-size') {
      classes.push(`text-[length:${arb(v)}]`);
      continue;
    }
    if (prop === 'border-width' && /^\d+(\.\d+)?px$/.test(v)) {
      classes.push(`border-[length:${arb(v)}]`);
      continue;
    }
    const pre = PREFIX[prop];
    if (pre && !/\s/.test(v)) {
      classes.push(`${pre}-[${arb(v)}]`);
      continue;
    }
    classes.push(`[${prop}:${arb(v)}]`);
  }
  return { className: classes.join(' '), style };
}
