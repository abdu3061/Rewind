import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native crypto and Windows Job Object suites assert real admission deadlines.
    // Avoid unrelated files exhausting those budgets through process/CPU contention.
    maxWorkers: 1,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    restoreMocks: true,
  },
});
