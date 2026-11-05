// Stage 1/4 — Figma adapter public API.
//
// From a Figma URL to code, end to end:
//
//   import { loadFromUrl } from './src/mcp/index.js';
//   import { figmaToIR } from './src/ir/index.js';
//   import { generateHtml } from './src/codegen/index.js';
//   import { verifyLoop } from './src/index.js';
//
//   const { raw, variableMap, componentMap, referencePng } =
//     await loadFromUrl(figmaUrl, { token: process.env.FIGMA_TOKEN });
//
//   const ir   = figmaToIR(raw, { variableMap, componentMap });
//   const html = generateHtml(ir);
//   const out  = await verifyLoop({ initialCode: html, referencePng, generate });

export { FigmaRestSource, RateLimitError, FigmaBlockedError } from './source.js';
export { FigmaMcpSource, extractImageBuffer } from './mcpSource.js';
export { loadFrame, loadFromUrl } from './loadFrame.js';
export { collectAssetIds, exportAssets } from './assets.js';
export { buildVariableMap, buildComponentMap, parseFigmaUrl, componentName } from './transform.js';
