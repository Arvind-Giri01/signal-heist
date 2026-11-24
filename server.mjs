import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from './game.mjs';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE rooms (code TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, expires INTEGER NOT NULL)');
const DB = {
  prepare(query) {
    const statement = sqlite.prepare(query);
    return {bind(...args) {
      return {
        first: async () => statement.get(...args),
        run: async () => ({meta:{changes: statement.run(...args).changes}})
      };
    }};
  }
};
const port = Number(process.env.PORT || 3420);
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request('http://localhost:' + port + req.url, {
    method:req.method, headers:req.headers, body:req.method === 'POST' ? Buffer.concat(chunks) : undefined
  });
  const response = await worker.fetch(request, {DB});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port,'0.0.0.0',() => console.log('Signal Heist listening on port ' + port));
