import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { captureResponse, ttlForPath } from './neonCache.js';

test('ttlForPath matches route prefixes only', () => {
  assert.equal(ttlForPath('/api/celestrak'), 7200);
  assert.equal(ttlForPath('/api/celestrak-satcat/stations'), 21600);
  assert.equal(ttlForPath('/api/celestrakx'), 0);
  assert.equal(ttlForPath('/api/flights'), 0);
});

async function roundTrip(write) {
  let captured;
  const server = http.createServer((_req, res) => {
    captured = captureResponse(res);
    write(res);
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  server.close();
  return { body, answer: await captured };
}

test('captures a 200 answer without changing what the client receives', async () => {
  const { body, answer } = await roundTrip((res) => {
    res.setHeader('Content-Type', 'application/json');
    res.write('{"a":');
    res.end('1}');
  });
  assert.equal(body, '{"a":1}');
  assert.equal(answer.body.toString(), '{"a":1}');
  assert.equal(answer.headers['content-type'], 'application/json');
});

test('does not capture errors or private answers', async () => {
  assert.equal(
    (
      await roundTrip((res) => {
        res.statusCode = 502;
        res.end('x');
      })
    ).answer,
    null,
  );
  assert.equal(
    (
      await roundTrip((res) => {
        res.setHeader('Cache-Control', 'private');
        res.end('x');
      })
    ).answer,
    null,
  );
});
