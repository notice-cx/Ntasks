// A stand-in for the npm registry on a local port, so the tests never reach
// npm. It answers the dist-tags of ntasks, the one request the command makes,
// and records every request.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRegistry {
  readonly url: string;
  /** The paths requested, in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

/** A registry whose latest ntasks release is `latest`. */
export async function fakeRegistry(latest: string): Promise<FakeRegistry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/-/package/ntasks/dist-tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ latest, next: '9.0.0-beta.1' }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** The address of a registry that refuses connections: a stand-in's, after it closed. */
export async function unreachableRegistry(): Promise<string> {
  const registry = await fakeRegistry('0.0.0');
  await registry.close();
  return registry.url;
}
