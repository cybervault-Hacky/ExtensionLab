import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Real-Docker end-to-end suite. Tests skip themselves explicitly when Docker
 * or the pinned sandbox image is unavailable; set EXTENSIONLAB_E2E_DOCKER=1
 * (CI does) to turn "unavailable" into a hard failure instead of a skip.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["default"],
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/__stubs__/server-only.ts"),
    },
  },
  ssr: {
    external: ["node:sqlite"],
  },
});
