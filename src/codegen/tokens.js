// Stage 6 helper — design tokens from the IR.
//
// Figma's Variables API is Enterprise-only, so most files arrive with no named
// tokens at all. The values are still there: every colour, font, size, radius
// and gap the design uses. Collecting them gives a team the starting point of a
// theme — CSS custom properties, a W3C DTCG tokens.json, and a Tailwind v4
// @theme block — instead of a few hundred hex literals scattered through code.
//
// Names are derived from the value (colour → its hex, font → its family), not
// invented ("primary", "accent"): the converter cannot know intent, and a name
// that lies is worse than a plain one. Rename them in your theme.

import { cssDeclarations } from './cssgen.js';

const COLOR_PROPS = new Set(['color', 'background-color', 'border-color']);
const SPACE_PROPS = new Set(['gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']);

/** Normalise a CSS colour literal to a stable key ("#c8960c", "rgba(…)" kept as-is). */
function colorKey(v) {
  const s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  return s;
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';

/** Token name for a colour value: hex → "c8960c", rgba(200,150,12,0.12) → "c8960c-12". */
export function colorTokenName(v) {
  const key = colorKey(v);
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(key);
  if (rgba) {
    const hex = [rgba[1], rgba[2], rgba[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    const a = rgba[4] !== undefined ? Math.round(Number(rgba[4]) * 100) : 100;
    return a === 100 ? hex : `${hex}-${a}`;
  }
  return slug(key);
}

const firstFamily = (v) => String(v).split(',')[0].trim().replace(/^['"]|['"]$/g, '');

/**
 * Walk the IR and count every token-worthy value.
 * @returns {{colors: Map<string,number>, fonts: Map<string,number>, fontSizes: Map<string,number>,
 *            radii: Map<string,number>, spacing: Map<string,number>}}
 */
export function extractTokens(ir) {
  const out = { colors: new Map(), fonts: new Map(), fontSizes: new Map(), radii: new Map(), spacing: new Map() };
  const bump = (m, k) => k && m.set(k, (m.get(k) || 0) + 1);
  const isLiteral = (v) => v && !String(v).includes('var(');
  const walk = (node, parentLayout) => {
    const d = cssDeclarations(node, { parentLayout, assets: {} });
    for (const [prop, value] of Object.entries(d)) {
      if (!isLiteral(value)) continue;
      if (COLOR_PROPS.has(prop)) bump(out.colors, colorKey(value));
      else if (prop === 'font-family') bump(out.fonts, firstFamily(value));
      else if (prop === 'font-size') bump(out.fontSizes, String(value));
      else if (prop === 'border-radius' && String(value) !== '0px') bump(out.radii, String(value));
      else if (SPACE_PROPS.has(prop)) {
        for (const part of String(value).split(/\s+/)) if (part !== '0px' && part !== '0') bump(out.spacing, part);
      }
    }
    for (const run of node.text?.runs || []) {
      if (run.style?.color) bump(out.colors, colorKey(run.style.color));
      if (run.style?.fontFamily) bump(out.fonts, run.style.fontFamily);
    }
    (node.children || []).forEach((c) => walk(c, node.layout));
  };
  walk(ir, null);
  return out;
}

const byUse = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
const pxNum = (v) => String(v).replace(/px$/, '').replace(/\./g, '_');

/**
 * Token files: tokens.json (W3C DTCG), tokens.css (:root custom properties) and
 * tailwind.theme.css (a Tailwind v4 @theme block so `bg-c8960c`, `font-crimson-pro`
 * etc. work as classes).
 * @returns {{ files: Record<string,string>, names: { colors: Map<string,string>, fonts: Map<string,string> }, counts: Object }}
 */
export function generateTokenFiles(ir) {
  const t = extractTokens(ir);
  const colorNames = new Map(byUse(t.colors).map(([v]) => [v, colorTokenName(v)]));
  const fontNames = new Map(byUse(t.fonts).map(([v]) => [v, slug(v)]));

  const dtcg = { color: {}, font: { family: {}, size: {} }, radius: {}, spacing: {} };
  const cssVars = [];
  const theme = [];
  for (const [v, n] of byUse(t.colors)) {
    const name = colorNames.get(v);
    dtcg.color[name] = { $type: 'color', $value: v, $extensions: { uses: n } };
    cssVars.push(`  --color-${name}: ${v};`);
    theme.push(`  --color-${name}: ${v};`);
  }
  for (const [v, n] of byUse(t.fonts)) {
    const name = fontNames.get(v);
    dtcg.font.family[name] = { $type: 'fontFamily', $value: v, $extensions: { uses: n } };
    cssVars.push(`  --font-${name}: '${v}', sans-serif;`);
    theme.push(`  --font-${name}: '${v}', sans-serif;`);
  }
  for (const [v, n] of byUse(t.fontSizes)) {
    dtcg.font.size[pxNum(v)] = { $type: 'dimension', $value: v, $extensions: { uses: n } };
    cssVars.push(`  --text-${pxNum(v)}: ${v};`);
    theme.push(`  --text-${pxNum(v)}: ${v};`);
  }
  for (const [v, n] of byUse(t.radii)) {
    dtcg.radius[pxNum(v)] = { $type: 'dimension', $value: v, $extensions: { uses: n } };
    cssVars.push(`  --radius-${pxNum(v)}: ${v};`);
    theme.push(`  --radius-${pxNum(v)}: ${v};`);
  }
  for (const [v, n] of byUse(t.spacing)) {
    dtcg.spacing[pxNum(v)] = { $type: 'dimension', $value: v, $extensions: { uses: n } };
    cssVars.push(`  --space-${pxNum(v)}: ${v};`);
  }

  const header =
    `/* Design tokens collected from the Figma frame "${ir.name}" by figma-codekit-mcp.\n` +
    `   Names follow the value (a colour is named by its hex) because the converter cannot\n` +
    `   know intent — rename them in your theme. Ordered by how often the design uses them. */\n`;
  return {
    files: {
      'tokens.json': JSON.stringify(dtcg, null, 2) + '\n',
      'tokens.css': `${header}:root {\n${cssVars.join('\n')}\n}\n`,
      'tailwind.theme.css': `${header}@theme {\n${theme.join('\n')}\n}\n`,
    },
    names: { colors: colorNames, fonts: fontNames },
    counts: {
      colors: t.colors.size,
      fonts: t.fonts.size,
      fontSizes: t.fontSizes.size,
      radii: t.radii.size,
      spacing: t.spacing.size,
    },
  };
}
