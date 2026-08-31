// test/setup.ts — global fetchMock lifecycle for every test file.
//
// fetchMock (from cloudflare:test) intercepts outbound fetch() calls made
// from inside the Worker under test — this is how we stub Mapbox and the
// Anthropic AI Gateway without hitting the real internet. disableNetConnect()
// means any un-mocked outbound request fails loudly instead of silently
// hitting the network, and assertNoPendingInterceptors() after each test
// catches mocks that were set up but never consumed.

import { fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});
