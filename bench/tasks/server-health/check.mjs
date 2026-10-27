import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { setTimeout } from 'node:timers';
import { finish } from '../../lib/checks.mjs';

// Start the service on a free port, as a user would, and ask it.
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = (passed, detail) => {
  server.kill('SIGKILL');
  finish(passed, detail);
};
setTimeout(() => stop(false, 'the server did not start within 10 seconds'), 10_000).unref();
server.on('exit', (code) => stop(false, `the server exited with code ${code}`));
/** Status and parsed JSON body of a GET request. */
const request = (url) =>
  new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(body);
        } catch {
          // Reported through the status and an empty body.
        }
        resolve({ status: response.statusCode, json });
      });
    }).on('error', reject);
  });

let output = '';
server.stdout.setEncoding('utf8').on('data', async (chunk) => {
  output += chunk;
  const port = /listening on (\d+)/.exec(output)?.[1];
  if (!port) return;
  server.stdout.removeAllListeners('data');
  try {
    const health = await request(`http://127.0.0.1:${port}/health`);
    if (health.status !== 200 || health.json.status !== 'ok')
      stop(false, `/health answered ${health.status} ${JSON.stringify(health.json)}`);
    const items = (await request(`http://127.0.0.1:${port}/items`)).json;
    const ids = (items.items ?? []).map((item) => item.id).sort();
    if (ids.join() !== 'kettle,mug,scale')
      stop(false, `/items listed ${JSON.stringify(ids)} instead of kettle, mug and scale`);
    stop(true, '/health answers 200 and /items lists the 3 items in stock');
  } catch (error) {
    stop(false, `request failed: ${error.message}`);
  }
});
