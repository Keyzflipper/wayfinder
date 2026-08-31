import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Runs tests inside real workerd via @cloudflare/vitest-pool-workers, not
// jsdom/node — so D1, R2, and Worker fetch semantics match production.
// Secrets normally supplied by .dev.vars (gitignored) are overridden here
// with fixed test values so the suite never depends on a developer's local
// .dev.vars existing.
export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ANTHROPIC_API_KEY: 'test-anthropic-key',
            MAPBOX_TOKEN: 'test-mapbox-token',
            GOOGLE_PLACES_API_KEY: 'test-google-places-key',
            CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
            AI_GATEWAY_ID: 'test-gateway-id',
          },
        },
      },
    },
  },
});
