import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// E2E tests boot a real Vendure server against an anvil fork of Base mainnet.
// They run sequentially because they share the anvil instance and ports.
export default defineConfig({
    test: {
        include: ['e2e/**/*.e2e-spec.ts'],
        fileParallelism: false,
        testTimeout: 120_000,
        hookTimeout: 240_000,
    },
    plugins: [swc.vite({ jsc: { transform: { useDefineForClassFields: false } } })],
});
