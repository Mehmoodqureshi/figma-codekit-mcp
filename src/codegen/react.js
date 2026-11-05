// Stage 6 — IR → React component (inline style objects).
//
// Secondary emitter — demonstrates the IR is framework-agnostic. Uses inline
// style objects so it's deterministic and pixel-exact out of the gate; a Tailwind
// class mapper can be layered on top of the same cssDeclarations() later.
//
// Bound components render as real JSX elements (<Badge variant="new" />), which is
// the whole point of Code Connect: instances become your components, not lookalikes.

import { ROLES, LAYOUT } from '../ir/schema.js';
import { cssDeclarations } from './cssgen.js';
import { toTailwind } from './tailwind.js';

// 1x1 transparent PNG, so an <img> whose asset never exported still lays out
// cleanly instead of showing a broken-image glyph. Same value as html.js.
const IMG_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const kebabToCamel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (name) =>
  (String(name || 'Node').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Node');

/**
 * Declaration map → a JS style-object literal string.
 *
 * `extra` is merged in as further entries rather than spread at the call site:
 * an <img> needs objectFit alongside the computed declarations, and
 * `{ ...{ a: 1 }, objectFit: 'cover' }` is both unreadable and a needless second
 * pass over a style object that can carry a multi-megabyte data URI.
 */
function styleLiteral(node, ctx, extra = null) {
  const d = cssDeclarations(node, ctx);
  const entries = Object.entries(d).map(([k, v]) => `${kebabToCamel(k)}: ${JSON.stringify(v)}`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) entries.push(`${k}: ${JSON.stringify(v)}`);
  }
  return `{ ${entries.join(', ')} }`;
}

/**
 * The styling attribute(s) for an element: an inline style object by default,
 * or Tailwind classes (plus a leftover style for anything a class cannot carry)
 * when ctx.tailwind is set.
 */
function styleAttrs(node, ctx, extra = null) {
  if (!ctx.tailwind) return `style={${styleLiteral(node, ctx, extra)}}`;
  const d = { ...cssDeclarations(node, ctx) };
  if (extra) for (const [k, v] of Object.entries(extra)) d[k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = v;
  const { className, style } = toTailwind(d, ctx.tokenNames);
  const rest = Object.entries(style).map(([k, v]) => `${kebabToCamel(k)}: ${JSON.stringify(v)}`);
  // An expression container, not a string attribute: JSX string attributes have
  // no escape sequences, so a class holding a quote would not parse.
  return `className={${JSON.stringify(className)}}${rest.length ? ` style={{ ${rest.join(', ')} }}` : ''}`;
}

/** props object → JSX attribute string. */
function propsToJsx(props = {}) {
  return Object.entries(props)
    .map(([k, v]) => (typeof v === 'string' ? `${k}=${JSON.stringify(v)}` : `${k}={${JSON.stringify(v)}}`))
    .join(' ');
}

function textTag(node) {
  const size = node.text?.fontSize ?? 14;
  if (size >= 28) return 'h1';
  if (size >= 22) return 'h2';
  if (size >= 18) return 'h3';
  return 'p';
}

/** A run's overrides as a JSX style object literal. */
function runStyleLiteral(style) {
  const d = {};
  if (style.fontFamily) d.fontFamily = `'${style.fontFamily}', sans-serif`;
  if (style.fontWeight) d.fontWeight = style.fontWeight;
  if (style.fontSize) d.fontSize = `${style.fontSize}px`;
  if (style.fontStyle) d.fontStyle = style.fontStyle;
  if (style.letterSpacing) d.letterSpacing = `${style.letterSpacing}px`;
  if (style.color) d.color = style.color;
  if (style.textTransform) d.textTransform = style.textTransform;
  if (style.textDecoration) d.textDecoration = style.textDecoration;
  const entries = Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * One run of copy → JSX children, with line breaks as <br />.
 *
 * Always an expression container, never a bare literal: design copy contains
 * braces, angle brackets and quotes often enough ("{name}", "A < B", "Terms &
 * Conditions") that interpolating it raw produces JSX that will not parse.
 *
 * A line break in Figma arrives as "\n" inside the run. Left alone it is just
 * whitespace to the browser, and these elements carry white-space:nowrap from
 * cssgen, so a two-line headline renders as one long line that overflows its
 * box — the design's own line breaks silently disappear. The HTML emitter turns
 * them into <br> (html.js, `br()`); this is the same rule for JSX.
 */
function runChildren(s) {
  return String(s ?? '')
    .split('\n')
    .map((part, i) => (i ? '<br />' : '') + (part ? `{${JSON.stringify(part)}}` : ''))
    .join('');
}

/** Text as JSX children. */
function textChildren(text) {
  if (!Array.isArray(text.runs) || text.runs.length === 0) return runChildren(text.content);
  return text.runs
    .map((run) => {
      const css = runStyleLiteral(run.style || {});
      return css === '{  }'
        ? runChildren(run.text)
        : `<span style={${css}}>${runChildren(run.text)}</span>`;
    })
    .join('');
}

function emit(node, indent, usedComponents, ctx) {
  const pad = '  '.repeat(indent);
  const style = styleAttrs(node, ctx);
  const childCtx = {
    responsive: ctx.responsive,
    parentLayout: node.layout,
    assets: ctx.assets,
    tailwind: ctx.tailwind,
    tokenNames: ctx.tokenNames,
  };

  switch (node.role) {
    case ROLES.TEXT: {
      const tag = textTag(node);
      return `${pad}<${tag} ${style}>${textChildren(node.text)}</${tag}>`;
    }
    case ROLES.IMAGE: {
      // A cropped fill cannot be expressed on an <img> — the crop window lives in
      // background-size/-position, which cssDeclarations has already emitted onto
      // the style object. Same split as the HTML emitter.
      const asset = ctx.assets?.[node.id];
      if (node.style.imageFit?.fit === 'crop' && asset) {
        return `${pad}<div ${style} role="img" aria-label=${JSON.stringify(node.name)} />`;
      }
      const fit = node.style.imageFit?.fit === 'contain' ? 'contain' : 'cover';
      const imgStyle = styleAttrs(node, ctx, { objectFit: fit });
      return `${pad}<img ${imgStyle} src={${JSON.stringify(asset || IMG_PLACEHOLDER)}} alt=${JSON.stringify(node.name)} />`;
    }
    case ROLES.VECTOR: {
      const asset = ctx.assets?.[node.id];
      if (asset) {
        const vecStyle = styleAttrs(node, ctx, { objectFit: 'contain' });
        return `${pad}<img ${vecStyle} src={${JSON.stringify(asset)}} alt=${JSON.stringify(node.name)} />`;
      }
      // No export: a faint dashed outline shows up as a difference without
      // dominating the diff the way a solid filled block does.
      return `${pad}<svg ${style} viewBox=${JSON.stringify(`0 0 ${node.box.width} ${node.box.height}`)} aria-label=${JSON.stringify(`${node.name} (asset not exported)`)}><rect width="100%" height="100%" rx="2" fill="none" stroke="#c8c8c8" strokeDasharray="3 3" /></svg>`;
    }
    case ROLES.COMPONENT: {
      // The instance's own content is passed as children rather than baked into
      // the component module. One design instantiates the same binding many
      // times with different copy — nav links, cards, price rows — so content
      // that lives in the module is content every instance shares, which is
      // wrong for all but the first. As children it stays per-instance, exactly
      // as the HTML emitter keeps it.
      if (!usedComponents.has(node.component.name)) usedComponents.set(node.component.name, node);
      const attrs = propsToJsx(node.component.props);
      const compStyle = `style={${styleLiteral(node, ctx)}}`;
      const open = `${pad}<${node.component.name} ${compStyle}${attrs ? ' ' + attrs : ''}`;
      if (!node.children || node.children.length === 0) return `${open} />`;
      const inner = node.children.map((c) => emit(c, indent + 1, usedComponents, childCtx)).join('\n');
      return `${open}>\n${inner}\n${pad}</${node.component.name}>`;
    }
    default: {
      const children = node.children.map((c) => emit(c, indent + 1, usedComponents, childCtx)).join('\n');
      return `${pad}<div ${style}>\n${children}\n${pad}</div>`;
    }
  }
}

/**
 * Generate a React component module from an IR tree.
 * @param {import('../ir/schema.js').IRNode} ir
 * @param {Object} [opts]
 * @param {string} [opts.componentName]  Defaults to PascalCase of the root name.
 * @param {Object<string,string>} [opts.assets]  node id → data URI, as for the
 *   HTML emitter. Without it images and vectors fall back to placeholders.
 * @returns {string} JSX source
 */
export function generateReact(ir, opts = {}) {
  const name = opts.componentName || pascal(ir.name);
  const usedComponents = new Map();
  // Same rule as the HTML emitter: a root with no Auto Layout has no sizing
  // intent to relax, so it keeps its exact CSS and gets scaled as a whole.
  // See canvasFitCss in cssgen.js for why relative units clip it instead.
  const canvasFit = Boolean(opts.responsive) && ir.layout?.mode === LAYOUT.ABSOLUTE;
  const minScale = opts.minScale ?? 0.5;
  const tree = emit(ir, canvasFit ? 6 : 2, usedComponents, {
    responsive: canvasFit ? false : opts.responsive || false,
    parentLayout: null,
    assets: opts.assets || {},
    tailwind: Boolean(opts.tailwind),
    tokenNames: opts.tokenNames || {},
  });

  const imports = [...usedComponents.keys()]
    .map((c) => `import { ${c} } from './components/${c}';`)
    .join('\n');

  if (!canvasFit) {
    return (
      `${imports ? imports + '\n\n' : ''}export function ${name}() {\n` +
      `  return (\n${tree}\n  );\n}\n`
    );
  }

  const W = Number(Number(ir.box.width).toFixed(2));
  const H = Number(Number(ir.box.height).toFixed(2));
  return (
    `import { useEffect, useState } from 'react';\n` +
    `${imports ? imports + '\n' : ''}\n` +
    `const DESIGN_WIDTH = ${W};\n` +
    `const DESIGN_HEIGHT = ${H};\n` +
    `const MIN_SCALE = ${minScale};\n\n` +
    `export function ${name}() {\n` +
    `  const [scale, setScale] = useState(1);\n` +
    `  useEffect(() => {\n` +
    `    const fit = () =>\n` +
    `      setScale(\n` +
    `        Math.min(1, Math.max(MIN_SCALE, document.documentElement.clientWidth / DESIGN_WIDTH))\n` +
    `      );\n` +
    `    fit();\n` +
    `    window.addEventListener('resize', fit);\n` +
    `    return () => window.removeEventListener('resize', fit);\n` +
    `  }, []);\n` +
    `  return (\n` +
    `    <div\n` +
    `      style={{\n` +
    `        position: 'relative',\n` +
    `        width: DESIGN_WIDTH * scale,\n` +
    `        height: DESIGN_HEIGHT * scale,\n` +
    `        margin: '0 auto',\n` +
    `        overflow: 'hidden',\n` +
    `      }}\n` +
    `    >\n` +
    `      <div style={{ transformOrigin: 'top left', transform: \`scale(\${scale})\` }}>\n` +
    `${tree}\n` +
    `      </div>\n` +
    `    </div>\n` +
    `  );\n}\n`
  );
}

/**
 * Every code component name bound anywhere in the tree.
 *
 * The walk descends THROUGH bound instances rather than stopping at them: a
 * component's own content can contain further instances, and those are emitted
 * at their own call site, so they need modules too.
 */
function collectBound(node, acc = new Set()) {
  if (node.role === ROLES.COMPONENT && node.component?.name) acc.add(node.component.name);
  for (const child of node.children || []) collectBound(child, acc);
  return acc;
}

/**
 * One module per bound code component — the files `generateReact()` imports.
 *
 * Without these the React and Next.js output does not compile: the parent says
 * `import { Badge } from './components/Badge'` and nothing ever writes that
 * file.
 *
 * Each module is a passthrough shell: it applies the `style` the parent
 * computed and renders `children`. It deliberately holds no design content of
 * its own, because a binding is instantiated many times across a frame with
 * different copy in each — content kept here would be content every instance
 * shares. The instance's own children are emitted at the call site instead, so
 * each one keeps what Figma put in it, and this file stays the small, obvious
 * thing you delete when you drop in your real component.
 *
 * @param {import('../ir/schema.js').IRNode} ir
 * @returns {Object<string,string>}  `<Name>.jsx` → JSX source.
 */
export function generateComponentModules(ir) {
  const out = {};
  for (const name of collectBound(ir)) {
    out[`${name}.jsx`] =
      `// ${name} — the component the generated page imports for this Code Connect\n` +
      `// binding. Replace it with your real one.\n` +
      `//\n` +
      `// Keep applying \`style\`: it carries the position and size the parent computed\n` +
      `// from the frame, and dropping it moves the component off its spot. Keep\n` +
      `// rendering \`children\` too — that is this instance's own content from Figma,\n` +
      `// which differs between instances of the same component.\n` +
      `export function ${name}({ style, children }) {\n` +
      `  return (\n` +
      `    <div style={style} data-component=${JSON.stringify(name)}>\n` +
      `      {children}\n` +
      `    </div>\n` +
      `  );\n` +
      `}\n`;
  }
  return out;
}
