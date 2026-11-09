// Checks the links and images of the built site in dist/ (lib/links.ts), and
// exits with 1 when one is dead. `pnpm build:site` runs it last.
import { fileURLToPath } from 'node:url';
import { checkLinks } from '../lib/links.ts';
import { BRANCH, REPOSITORY, SITE_ORIGIN } from '../lib/site.ts';

const dead = checkLinks({
  distDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  repoDir: fileURLToPath(new URL('../../../', import.meta.url)),
  siteOrigin: SITE_ORIGIN,
  repository: REPOSITORY,
  branch: BRANCH,
});

for (const link of dead) console.error(`${link.page}: ${link.href}: ${link.reason}`);
if (dead.length > 0) {
  console.error(`${dead.length} dead link${dead.length === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log('Every link and image in dist/ resolves.');
