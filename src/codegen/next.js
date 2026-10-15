// Stage 6 — IR → a runnable Next.js App Router project.
//
// This is a thin arrangement of generateReact(), not a third emitter: the
// component file is byte-for-byte what the React option produces, and the rest
// of the tree is the App Router scaffolding needed to actually `npm run dev` it.
// Keeping it that way means React and Next.js can never drift apart in what they
// say the design looks like.
//
// Two details the App Router forces:
//
//  • A canvas-fit design (no Auto Layout on the root) scales itself with
//    useState/useEffect, and hooks only run in a client component — so that
//    variant gets a 'use client' directive and the Auto Layout one does not.
//  • Fonts go through globals.css rather than <link> tags in the layout, because
//    @import is the one mechanism that works the same in `next dev`, `next build`
//    and a plain copy-paste of the file into another project.

import { generateReact, generateComponentModules } from './react.js';
import { RESET, collectTokenVars } from './cssgen.js';
import { fontStylesheetUrls } from './html.js';

const pascal = (name) =>
  (String(name || 'Node')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('') || 'Node');

const kebab = (name) =>
  String(name || 'figma-frame')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'figma-frame';

/**
 * IR → the files of a Next.js App Router project.
 *
 * @param {object} ir                 The IR root.
 * @param {object} [opts]
 * @param {object} [opts.assets]      id → data URI, as for the other emitters.
 * @param {boolean} [opts.responsive] Emit the responsive/canvas-fit variant.
 * @param {string} [opts.title]       Page title. Defaults to the frame name.
 * @param {number} [opts.minScale]    Canvas-fit floor. Defaults to 0.5.
 * @returns {{files: Record<string,string>, componentName: string, entry: string, useClient: boolean}}
 */
export function generateNext(ir, opts = {}) {
  const { assets = {}, responsive = false, minScale = 0.5 } = opts;
  const title = opts.title || ir.name || 'Generated';
  const name = opts.componentName || pascal(ir.name);

  const component = generateReact(ir, { assets, responsive, minScale, componentName: name });

  // The component file imports './components/<X>' for every Code Connect
  // binding. Those modules have to ship with it or `next dev` dies on the first
  // import — see generateComponentModules().
  const modules = generateComponentModules(ir);

  // The canvas-fit variant measures the viewport with useState/useEffect. Server
  // components have neither, so that file has to opt into the client boundary.
  const useClient = /\buse(?:State|Effect)\b/.test(component);

  const fontImports = fontStylesheetUrls(ir)
    .map((u) => `@import url("${u}");`)
    .join('\n');

  // Same reasoning as the HTML emitter: tokens are referenced as
  // var(--x, <exact figma value>), so defining them as empty here would shadow
  // the fallback with nothing. They are listed for discoverability instead.
  const tokens = [...collectTokenVars(ir).keys()];

  const globals = [
    fontImports,
    fontImports ? '' : null,
    tokens.length ? `/* Design tokens to define in your theme: ${tokens.join(', ')} */` : null,
    RESET.replace(/\} /g, '}\n'),
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const files = {
    [`app/${name}.jsx`]: (useClient ? "'use client';\n\n" : '') + component,

    'app/page.jsx':
      `import { ${name} } from './${name}';\n\n` +
      `export default function Page() {\n` +
      `  return <${name} />;\n` +
      `}\n`,

    'app/layout.jsx':
      `import './globals.css';\n\n` +
      `export const metadata = {\n` +
      `  title: ${JSON.stringify(title)},\n` +
      `};\n\n` +
      `export default function RootLayout({ children }) {\n` +
      `  return (\n` +
      `    <html lang="en">\n` +
      `      <body>{children}</body>\n` +
      `    </html>\n` +
      `  );\n` +
      `}\n`,

    'app/globals.css': globals,

    ...Object.fromEntries(
      Object.entries(modules).map(([file, src]) => [`app/components/${file}`, src])
    ),

    'package.json':
      JSON.stringify(
        {
          name: kebab(ir.name),
          private: true,
          version: '0.1.0',
          scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
          dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
        },
        null,
        2
      ) + '\n',

    'next.config.mjs':
      `/** @type {import('next').NextConfig} */\n` +
      `// Every image and vector is inlined as a data URI by the converter, so\n` +
      `// there is nothing here for next/image to optimise and no remote host to\n` +
      `// allow-list. The project runs offline exactly as exported.\n` +
      `const nextConfig = {};\n\n` +
      `export default nextConfig;\n`,

    'README.md':
      `# ${title}\n\n` +
      `Figma frame converted to a Next.js project.\n\n` +
      '```bash\nnpm install\nnpm run dev\n```\n\n' +
      `\`app/${name}.jsx\` is the component — the same file the React option emits.\n` +
      `Images and vectors are inlined as data URIs, so it renders with no network.\n` +
      (Object.keys(modules).length
        ? `\n\`app/components/\` holds one file per Code Connect binding ` +
          `(${Object.keys(modules).length}), generated from each instance's own content. ` +
          `Swap them for your real components — keep applying the \`style\` prop.\n`
        : '') +
      (useClient
        ? `\nThis frame has no Auto Layout on its root, so the component scales the whole\n` +
          `canvas to the viewport and is marked \`'use client'\` for the hooks that needs.\n`
        : '') +
      (tokens.length
        ? `\nDesign tokens referenced: ${tokens.join(', ')}. They are emitted as\n` +
          `\`var(--token, <exact value>)\`, so the exact Figma value is used until you\n` +
          `define the token, and your token wins the moment you do.\n`
        : ''),
  };

  return {
    files,
    componentName: name,
    entry: `app/${name}.jsx`,
    useClient,
    components: Object.keys(modules).map((f) => f.replace(/\.jsx$/, '')),
  };
}
