import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["lcov", "text"],
      include: ["source/**/*.ts"],
      exclude: ["test/**/*.test.ts"],
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
