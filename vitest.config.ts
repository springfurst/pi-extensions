import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live-network tests are opt-in: `npm run test:live`.
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
