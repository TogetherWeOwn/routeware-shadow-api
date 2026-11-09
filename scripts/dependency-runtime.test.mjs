import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const fromMiniflare = createRequire(require.resolve('miniflare/package.json'));
const undici = fromMiniflare('undici');
const ws = fromMiniflare('ws');
const mf = require('miniflare');

test('Miniflare preserves Request/Response subclasses, clone, headers, stream and 101', async () => {
  const request = new mf.Request('https://synthetic.invalid/input', {
    method: 'POST', body: 'synthetic body', cf: { country: 'XX' },
    headers: { 'x-synthetic': 'yes' },
  });
  const clone = request.clone();
  assert.ok(clone instanceof mf.Request);
  assert.deepEqual(clone.cf, request.cf);
  assert.equal(clone.headers.get('x-synthetic'), 'yes');
  assert.equal(await clone.text(), 'synthetic body');
  assert.equal(await request.text(), 'synthetic body');
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('streamed')); controller.close(); },
  });
  const response = new mf.Response(stream, { headers: { 'x-synthetic': 'stream' } });
  const responseClone = response.clone();
  assert.ok(responseClone instanceof mf.Response);
  assert.equal(responseClone.headers.get('x-synthetic'), 'stream');
  assert.equal(await responseClone.text(), 'streamed');
  assert.equal(await response.text(), 'streamed');
  assert.equal(mf.Response.error().status, 0);
  assert.equal(mf.Response.redirect('https://synthetic.invalid/next', 307).status, 307);
  const pair = new mf.WebSocketPair();
  const upgrade = new mf.Response(null, { status: 101, webSocket: pair[0] });
  assert.equal(upgrade.status, 101);
  assert.equal(upgrade.webSocket, pair[0]);
});

test('Miniflare fetch and dispatcher preserve local/outbound routing without network', { timeout: 5000 }, async (t) => {
  const outbound = new undici.MockAgent();
  const local = new undici.MockAgent();
  outbound.disableNetConnect(); local.disableNetConnect();
  const dispatcher = new mf.DispatchFetchDispatcher(
    outbound, local, 'http://runtime.invalid', 'https://worker.invalid', { country: 'XX' },
  );
  t.after(() => dispatcher.close());
  local.get('http://runtime.invalid').intercept({
    path: '/local', headers: {
      [mf.CoreHeaders.ORIGINAL_URL]: 'https://worker.invalid/local',
      [mf.CoreHeaders.CF_BLOB]: JSON.stringify({ country: 'XX' }),
    },
  }).reply(200, 'runtime');
  outbound.get('https://outbound.invalid').intercept({ path: '/external' }).reply(201, 'outbound');
  const runtime = await mf.fetch('https://worker.invalid/local', { dispatcher });
  assert.ok(runtime instanceof mf.Response);
  assert.equal(await runtime.text(), 'runtime');
  const external = await mf.fetch('https://outbound.invalid/external', { dispatcher });
  assert.equal(external.status, 201);
  assert.equal(await external.text(), 'outbound');
  await assert.rejects(mf.fetch('https://unmocked.invalid', { dispatcher }), /fetch failed/);
  outbound.assertNoPendingInterceptors(); local.assertNoPendingInterceptors();
});

test('the embedded sync-fetch worker uses the same patched Undici and settles errors', { timeout: 5000 }, async (t) => {
  // Execute the SHIPPED worker body, not a rewritten facsimile. Replace only the
  // worker port and Pool socket boundary; there is no server, socket or Worker
  // thread. Real workerd/Worker IPC remains covered by the existing pool suite.
  const filename = require.resolve('miniflare');
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('var WORKER_SCRIPT = (');
  const end = source.indexOf('var SynchronousFetcher = class', start);
  assert.ok(start >= 0 && end > start, 'pinned sync-fetch worker marker');
  const template = source.slice(start, end);
  const script = runInNewContext(template.slice(template.indexOf('`'), template.lastIndexOf('`') + 1), {
    CoreHeaders: mf.CoreHeaders,
  });
  const agent = new undici.MockAgent();
  agent.disableNetConnect();
  t.after(() => agent.close());
  agent.get('https://sync.invalid').intercept({ path: '/body' }).reply(200, 'sync body');
  const optionsSeen = [];
  const messages = [];
  let receive;
  const notifyHandle = new Int32Array(new SharedArrayBuffer(4));
  const port = {
    addEventListener(name, handler) { assert.equal(name, 'message'); receive = handler; },
    postMessage(message) { messages.push(message); }, start() {},
  };
  const fakeRequire = (name) => {
    if (name === 'worker_threads') return { workerData: { filename, port, notifyHandle } };
    assert.equal(name, 'module');
    return { createRequire(base) {
      assert.equal(base, filename);
      const actualRequire = createRequire(base);
      assert.equal(actualRequire('undici/package.json').version, '7.30.1');
      return (dependency) => {
        assert.equal(dependency, 'undici');
        return { ...actualRequire(dependency), Pool: class {
          constructor(origin, options) { optionsSeen.push({ origin, options }); return agent; }
        } };
      };
    } };
  };
  runInNewContext(script, { require: fakeRequire, URL, Atomics });
  await receive({ data: { id: 1, method: 'GET', url: 'https://sync.invalid/body', headers: {} } });
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].response.status, 200);
  assert.equal(new TextDecoder().decode(messages[0].response.body), 'sync body');
  assert.deepEqual(optionsSeen[0].options.connect.rejectUnauthorized, false);
  assert.equal(optionsSeen[0].options.headersTimeout, 0);
  assert.equal(optionsSeen[0].options.bodyTimeout, 0);
  assert.equal(Atomics.load(notifyHandle, 0), 1);
  Atomics.store(notifyHandle, 0, 0);
  await receive({ data: { id: 2, method: 'GET', url: 'https://unmocked.invalid/error', headers: {} } });
  assert.equal(messages[1].id, 2);
  assert.ok(messages[1].error);
  assert.equal(Atomics.load(notifyHandle, 0), 1);
  agent.assertNoPendingInterceptors();
});

test('ws fragment limits refuse a third tiny fragment and allow the boundary', { timeout: 5000 }, async () => {
  const options = { isServer: false, maxPayload: 64, maxFragments: 2, maxBufferedChunks: 4 };
  const receiver = new ws.Receiver(options);
  const error = once(receiver, 'error');
  receiver.write(Buffer.from([0x02, 1, 65]));
  receiver.write(Buffer.from([0x00, 1, 66]));
  receiver.write(Buffer.from([0x80, 1, 67]));
  const [failure] = await error;
  assert.equal(failure.code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
  const valid = new ws.Receiver(options);
  const message = once(valid, 'message');
  valid.write(Buffer.from([0x02, 1, 65]));
  valid.write(Buffer.from([0x80, 1, 66]));
  const [data] = await message;
  assert.equal(data.toString(), 'AB');
  valid.destroy();
});

test('ws buffered-chunk limits refuse tiny incomplete frames without exhaustion loads', { timeout: 5000 }, async () => {
  const receiver = new ws.Receiver({ isServer: false, maxPayload: 64, maxFragments: 2, maxBufferedChunks: 2 });
  const error = once(receiver, 'error');
  receiver.write(Buffer.from([0x82, 10]));
  receiver.write(Buffer.from([1]));
  receiver.write(Buffer.from([2]));
  receiver.write(Buffer.from([3]));
  const [failure] = await error;
  assert.equal(failure.code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
});

test('the Miniflare-resolved ws server defaults are bounded without opening a listener', (t) => {
  const server = new ws.WebSocketServer({ noServer: true });
  t.after(() => server.close());
  assert.equal(server.options.maxBufferedChunks, 262144);
  assert.equal(server.options.maxFragments, 16384);
  assert.equal(server.options.maxPayload, 100 * 1024 * 1024);
});

test('both consumers execute the reviewed esbuild binary with plugins/context/metafiles', { timeout: 15000 }, async () => {
  assert.equal(process.env.ESBUILD_BINARY_PATH, undefined, 'no alternate binary');
  for (const parent of ['wrangler', '@cloudflare/vitest-pool-workers']) {
    const fromParent = createRequire(require.resolve(`${parent}/package.json`));
    const esbuild = fromParent('esbuild');
    assert.equal(esbuild.version, '0.28.2');
    let resolved = false;
    let ended = false;
    const result = await esbuild.build({
      entryPoints: ['synthetic-entry'], bundle: true, write: false, metafile: true,
      target: 'es2024', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'synthetic-only', setup(build) {
        build.onResolve({ filter: /^synthetic-entry$/ }, () => {
          resolved = true; return { path: 'entry.js', namespace: 'synthetic' };
        });
        build.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
          contents: 'export const answer = 42; export default { fetch() {} };', loader: 'js',
        }));
        build.onEnd(() => { ended = true; });
      } }],
    });
    assert.ok(resolved && ended);
    const output = Object.values(result.metafile.outputs)[0];
    assert.deepEqual(output.exports, ['answer', 'default']);
    const context = await esbuild.context({
      stdin: { contents: 'export const value: number = 42', loader: 'ts' },
      write: false, logLevel: 'silent',
    });
    try { assert.match((await context.rebuild()).outputFiles[0].text, /42/); }
    finally { await context.dispose(); }
    assert.match(esbuild.formatMessagesSync([{ text: 'synthetic warning' }], { kind: 'warning' })[0], /synthetic warning/);
  }
});
