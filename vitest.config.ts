import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/__stubs__/server-only.ts"),
    },
  },
  ssr: {
    external: ["node:sqlite"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
  },
});
