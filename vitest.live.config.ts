import { defineConfig } from 'vitest/config';

// Live suites run against a real Supabase stack (local CLI stack or the dev project).
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
