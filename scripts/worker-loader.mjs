/**
 * ESM resolve hook for running the TypeScript worker directly on Node 22+
 * (`--experimental-transform-types`). It maps the `@/` alias to the repository
 * root, stubs the `server-only` marker package and resolves extensionless
 * TypeScript imports. No bundler and no additional dependency is needed.
 */
import { register } from "node:module";

register("./worker-resolve-hooks.mjs", import.meta.url);
