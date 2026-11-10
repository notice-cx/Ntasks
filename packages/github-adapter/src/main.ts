/**
 * Runs the adapter:
 *
 *   GITHUB_TOKEN=… node src/main.ts --config adapter.json [--port 8790] [--host 127.0.0.1]
 *
 * README.md describes the configuration file.
 */
import { parseArgs } from 'node:util';
import { readConfig } from './config.ts';
import { createAdapter, MCP_PATH } from './server.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { config: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' } },
});
if (values.config === undefined) {
  console.error('Usage: GITHUB_TOKEN=… node src/main.ts --config adapter.json [--port 8790] [--host 127.0.0.1]');
  process.exit(2);
}
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') {
  console.error('Set GITHUB_TOKEN to a token that may read and write the configured repositories’ issues.');
  process.exit(2);
}
const config = readConfig(values.config);
const { server } = createAdapter(config, { githubToken: token, githubSpacing: 1000 });
const port = Number(values.port ?? '8790');
const host = values.host ?? '127.0.0.1';
server.listen(port, host, () => console.log(`Serving the Shared Work Protocol at http://${host}:${port}${MCP_PATH}`));
