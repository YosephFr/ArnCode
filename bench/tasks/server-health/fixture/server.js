import { createServer } from 'node:http';
import { checkStorage, listItems } from './lib/store.js';

const port = Number(process.env.PORT ?? 3000);

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      await checkStorage();
      return send(response, 200, { status: 'ok' });
    }
    if (request.method === 'GET' && request.url === '/items') {
      return send(response, 200, { items: await listItems() });
    }
    send(response, 404, { error: 'Not found' });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`listening on ${server.address().port}`);
});
