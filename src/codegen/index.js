// Stage 6 — codegen public API.
//
//   import { generateHtml } from './src/codegen/index.js';
//   const html = generateHtml(ir);      // self-contained, renders in the verify loop
//   const jsx  = generateReact(ir);     // React component (inline styles)
//   const mod  = generateComponentModules(ir); // the './components/*' it imports
//   const app  = generateNext(ir);      // { files } — a runnable Next.js project
//
// generateHtml() is the deterministic first pass that feeds the Stage 7 verify
// loop as `initialCode`; the loop + your LLM then refine it toward pixel-exact.

export { generateHtml } from './html.js';
export { generateReact, generateComponentModules } from './react.js';
export { generateNext } from './next.js';
export { cssDeclarations, declToString, tokenToVar, collectTokenVars } from './cssgen.js';
export { fontStylesheetUrls } from './html.js';
export { externalizeAssets, copyAssetFiles, decodeDataUri } from './assetFiles.js';
export { generateTokenFiles, extractTokens } from './tokens.js';
export { toTailwind } from './tailwind.js';
