import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('runs queue for memory instead of going over the plan limit', async () => {
  const { acquireMemory, releaseMemory, setMemoryBudget } = await import('../pipeline/lib/apify.js');
  setMemoryBudget(8192);
  const order = [];
  const a = await acquireMemory(4096), b = await acquireMemory(4096);
  const c = acquireMemory(4096).then(mb => { order.push('c'); return mb; });
  const d = acquireMemory(512).then(mb => { order.push('d'); return mb; });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, []);
  releaseMemory(a);
  const mc = await c;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['c']); // the 512 MB run still doesn't fit next to two 4 GB runs
  releaseMemory(b);
  const md = await d;
  assert.deepEqual(order, ['c', 'd']);
  [mc, md].forEach(releaseMemory);
  setMemoryBudget(16384);
});

test('a run refused for memory waits and retries, then returns its results', async () => {
  let starts = 0;
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url.startsWith('/acts/me~scraper?')) return json(200, { data: { defaultRunOptions: { memoryMbytes: 1024 } } });
    if (req.method === 'GET' && req.url === '/acts/me~scraper') return json(200, { data: { defaultRunOptions: { memoryMbytes: 1024 } } });
    if (req.method === 'POST' && req.url.startsWith('/acts/me~scraper/runs')) {
      starts++;
      if (starts === 1) return json(402, { error: { type: 'not-enough-memory', message: 'By launching this job you will exceed the memory limit of 16384MB' } });
      return json(201, { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } });
    }
    if (req.url.startsWith('/datasets/ds1/items')) return json(200, [{ id: 'e1' }, { id: 'e2' }]);
    json(404, { error: { message: 'nope' } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.APIFY_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const { runActor } = await import('../pipeline/lib/apify.js?retry');
  const out = await runActor('me~scraper', {}, { token: 't', memoryWaitMs: 10 });
  server.close();
  assert.equal(starts, 2);
  assert.deepEqual(out.items, [{ id: 'e1' }, { id: 'e2' }]);
});
