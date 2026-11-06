import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Every test file starts on the current schema: each migration in
// ../migrations, applied in order to this run's local database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
