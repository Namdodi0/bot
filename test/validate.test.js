import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageValidator, isPrivateAddress } from '../src/core/media/validate.js';

/** @param {{status?: number, headers?: Record<string,string>, throws?: boolean}} spec */
function fakeResponse(spec = {}) {
  if (spec.throws) throw new Error('network down');
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(spec.headers ?? {}),
    body: { cancel: async () => {} },
  };
}

/** Hostnames in tests always resolve to a public IP (avoids real DNS). */
const publicLookup = async () => ['203.0.113.10'];

/** @param {typeof fetch} fetchImpl @param {Record<string, any>} [extra] */
function makeValidator(fetchImpl, extra = {}) {
  return createImageValidator({ fetchImpl, lookup: publicLookup, ...extra });
}

test('accepts images with an image/* content-type', async () => {
  const validator = makeValidator(async () => fakeResponse({ headers: { 'content-type': 'image/png' } }));
  const result = await validator.validate('https://example.com/a.png');
  assert.equal(result.ok, true);
});

test('rejects a content-type that is not an image', async () => {
  const validator = makeValidator(async () => fakeResponse({ headers: { 'content-type': 'text/html' } }));
  const result = await validator.validate('https://example.com/page');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /content-type/);
});

test('falls back to GET when HEAD returns 403', async () => {
  const calls = [];
  const validator = makeValidator(async (_url, opts) => {
    calls.push(opts.method);
    if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
    return fakeResponse({ status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  const result = await validator.validate('https://example.com/b.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('tries GET when HEAD fails on the network', async () => {
  let first = true;
  const validator = makeValidator(async () => {
    if (first) {
      first = false;
      return fakeResponse({ throws: true });
    }
    return fakeResponse({ headers: { 'content-type': 'image/webp' } });
  });
  const result = await validator.validate('https://example.com/c.webp');
  assert.equal(result.ok, true);
});

test('caches results by URL', async () => {
  let calls = 0;
  const validator = makeValidator(async () => {
    calls += 1;
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  await validator.validate('https://example.com/d.png');
  await validator.validate('https://example.com/d.png');
  assert.equal(calls, 1);
});

/** @param {Buffer|string} body @param {{status?: number, headers?: Record<string,string>}} [spec] */
function bodyResponse(body, spec = {}) {
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(spec.headers ?? {}),
    body: { cancel: async () => {} },
    arrayBuffer: async () => Buffer.from(body),
  };
}

test('download returns validated bytes for transports that upload files', async () => {
  const validator = makeValidator(async () =>
    bodyResponse('png-bytes', { headers: { 'content-type': 'image/png' } }),
  );
  const result = await validator.download('https://example.com/a.png');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, Buffer.from('png-bytes'));
  assert.equal(result.contentType, 'image/png');
});

test('download rejects non-images and bodies over maxBytes', async () => {
  const notImage = makeValidator(async () => bodyResponse('html', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await notImage.download('https://example.com/a.png')).ok, false);

  const huge = makeValidator(async () => bodyResponse('0123456789', { headers: { 'content-type': 'image/png' } }), {
    maxBytes: 5,
  });
  const result = await huge.download('https://example.com/a.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /too large/);
});

test('download refuses a redirect to an internal address', async () => {
  let calls = 0;
  const validator = makeValidator(async () => {
    calls += 1;
    return bodyResponse('', { status: 302, headers: { location: 'https://127.0.0.1/a.png' } });
  });
  const result = await validator.download('https://example.com/a.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /internal address/);
  assert.equal(calls, 1);
});

test('readText returns HTML as text and rejects binary content', async () => {
  const page = makeValidator(async () =>
    bodyResponse('<html><title>T</title><p>Hello</p></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  );
  const result = await page.readText('https://example.com/page');
  assert.equal(result.ok, true);
  assert.match(result.text, /Hello/);
  assert.equal(result.finalUrl, 'https://example.com/page');

  const binary = makeValidator(async () => bodyResponse('PNG', { headers: { 'content-type': 'image/png' } }));
  const refused = await binary.readText('https://example.com/file');
  assert.equal(refused.ok, false);
  assert.match(String(refused.reason), /unsupported content-type/);
});

test('download returns a failure for a malformed redirect location', async () => {
  const validator = makeValidator(async () =>
    bodyResponse('', { status: 302, headers: { location: 'http://[' } }),
  );
  const result = await validator.download('https://example.com/a.png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid redirect');
});

test('rejects images that are too large even when HEAD returns content-length', async () => {
  const validator = makeValidator(async () =>
    fakeResponse({ headers: { 'content-type': 'image/png', 'content-length': String(100 * 1024 * 1024) } }),
  );
  const result = await validator.validate('https://example.com/huge.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /too large/);
});

test('ranged GET uses content-range to learn the total size', async () => {
  const validator = makeValidator(async (_url, opts) => {
    if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
    return fakeResponse({
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-length': '2',
        'content-range': 'bytes 0-1/52428800',
      },
    });
  });
  const result = await validator.validate('https://example.com/big-range.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /too large/);
});

test('rejects an invalid URL', async () => {
  const validator = makeValidator(async () => fakeResponse());
  const result = await validator.validate('ftp://example.com/a.png');
  assert.equal(result.ok, false);
});

test('isPrivateAddress recognizes internal ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '203.0.113.10', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('isPrivateAddress blocks IPv4-mapped/NAT64/6to4/Teredo forms', () => {
  for (const address of [
    '::ffff:7f00:1', // 127.0.0.1 in hex
    '::ffff:a9fe:a9fe', // 169.254.169.254 in hex
    '::ffff:c0a8:105', // 192.168.1.5
    '64:ff9b::7f00:1', // NAT64
    '2002:7f00:1::1', // 6to4
    '2001:0:0:0:0:0:0:1', // Teredo
    'fec0::1', // site-local
    'ff02::1', // multicast
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['::ffff:808:808', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('blocks hostnames that resolve to an IPv4-mapped internal address', async () => {
  let calls = 0;
  const validator = createImageValidator({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({ headers: { 'content-type': 'image/png' } });
    },
    lookup: async () => ['::ffff:127.0.0.1'],
  });
  const result = await validator.validate('https://internal.example/a.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /internal/);
  assert.equal(calls, 0);
});

test('blocks URLs pointing straight at an internal IP (no network call)', async () => {
  let calls = 0;
  const validator = makeValidator(async () => {
    calls += 1;
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  for (const url of ['http://127.0.0.1:8787/metrics', 'http://192.168.1.5/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png']) {
    const result = await validator.validate(url);
    assert.equal(result.ok, false, url);
    assert.match(String(result.reason), /internal/, url);
  }
  assert.equal(calls, 0);
});

test('blocks hostnames that resolve to an internal IP', async () => {
  const validator = createImageValidator({
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' } }),
    lookup: async () => ['10.0.0.5'],
  });
  const result = await validator.validate('https://internal.example/a.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /internal/);
});

test('follows redirects manually and blocks redirects to an internal IP', async () => {
  const targets = [];
  const validator = makeValidator(async (url) => {
    targets.push(String(url));
    return fakeResponse({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  });
  const result = await validator.validate('https://example.com/redirect.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /internal/);
  assert.ok(
    targets.every((url) => !url.includes('169.254.169.254')),
    'must not call the internal destination',
  );
});

test('follows a public redirect to a valid image', async () => {
  const targets = [];
  const validator = makeValidator(async (url) => {
    targets.push(String(url));
    if (targets.length === 1) {
      return fakeResponse({ status: 301, headers: { location: 'https://cdn.example/x.png' } });
    }
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  const result = await validator.validate('https://example.com/start.png');
  assert.equal(result.ok, true);
  assert.equal(targets.length, 2);
});

test('blocks a redirect loop with too many hops', async () => {
  const validator = makeValidator(async () =>
    fakeResponse({ status: 302, headers: { location: 'https://example.com/loop.png' } }),
  );
  const result = await validator.validate('https://example.com/loop.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /redirect/i);
});
