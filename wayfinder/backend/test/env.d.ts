/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from '../src/types';

// Lets `env` imported from 'cloudflare:test' carry our actual binding
// types instead of the empty default `ProvidedEnv`.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
