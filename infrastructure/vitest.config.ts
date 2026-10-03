import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CDK Template.fromStack assertions are plain Node work (no DOM); run in a
    // single fork so the per-test process.env save/restore in test/helpers.ts
    // cannot race across workers.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    }
  }
});
