// Use tsx's CommonJS hook so the worker can load the repository's extensionless
// TypeScript imports when Vite starts from its bundled CommonJS config.
const { register } = require("tsx/cjs/api");
register();
require("./pair-feature-generation-worker.ts");
