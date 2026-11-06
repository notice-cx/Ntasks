/// <reference types="@cloudflare/vitest-plugin/types" />

// The bindings vitest.config.ts adds for tests. Declared here, in the tests'
// own TypeScript project, so the Worker's source never sees them.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
