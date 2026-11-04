import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { AppError, callModel } from "../server/provider.js";

async function fixture(t, handler, timeoutMs = 1000) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    model: {
      id: "transport-test", name: "Transport test", kind: "live", model: "test",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      maxTokens: 64, tokenParameter: "max_tokens", temperature: null,
      timeoutMs, inputPrice: null, outputPrice: null,
    },
    requests: () => requests,
  };
}
const messages = [{ role: "user", content: "hello" }];
function failure(kind, phase, text) {
  return error => {
    assert(error instanceof AppError, "Transport failures must be safe, actionable AppErrors");
    assert.equal(error.failureKind, kind);
    assert.equal(error.failurePhase, phase);
    assert.match(error.message, text);
    assert(!error.message.includes("private-test-key"));
    return true;
  };
}

test("response body timeout is actionable rather than an unclassified internal error", async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    res.write('{"private":"private-test-key",');
  }, 500);
  await assert.rejects(callModel(f.model, messages), failure("timeout", "body", /超时/));
  assert.equal(f.requests(), 1);
});

test("waiting for response headers times out without retrying", async t => {
  const f = await fixture(t, () => {}, 500);
  await assert.rejects(callModel(f.model, messages), failure("timeout", "headers", /超时/));
  assert.equal(f.requests(), 1);
});

test("caller cancellation before headers is not a connection or timeout failure", async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, () => ready());
  const controller = new AbortController();
  const checked = assert.rejects(callModel(f.model, messages, { signal: controller.signal }),
    failure("cancelled", "headers", /取消/));
  await started;
  controller.abort(new Error("private-test-key"));
  await checked;
  assert.equal(f.requests(), 1);
});

test("caller cancellation during body reading remains a cancellation", async t => {
  const controller = new AbortController();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    res.write('{"private":"private-test-key",');
  });
  const realFetch = globalThis.fetch;
  // Abort only once fetch has returned headers. The unfinished body then rejects
  // on read, independently of socket-delivery timing on slow CI machines.
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await realFetch(...args);
    controller.abort(new Error("private-test-key"));
    return response;
  });
  await assert.rejects(callModel(f.model, messages, { signal: controller.signal }),
    failure("cancelled", "body", /取消/));
  assert.equal(f.requests(), 1);
});

test("broken response body is a sanitized read failure and is not retried", async t => {
  let disconnect;
  const f = await fixture(t, (_req, res) => {
    disconnect = () => res.destroy();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    res.write('{"private":"private-test-key",');
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await realFetch(...args);
    disconnect();
    return response;
  });
  await assert.rejects(callModel(f.model, messages), failure("response_read", "body", /读取/));
  assert.equal(f.requests(), 1);
});

test("connection errors do not expose raw failure causes", async t => {
  const f = await fixture(t, () => {});
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    throw new Error("connection refused private-test-key");
  });
  await assert.rejects(callModel(f.model, messages), failure("connection", "headers", /连接/));
  assert.equal(attempts, 1);
});

test("the first abort reason wins when cancellation and timeout both happen", async t => {
  const f = await fixture(t, () => {}, 20);
  for (const first of ["cancelled", "timeout"]) {
    const controller = new AbortController();
    const mock = t.mock.method(globalThis, "fetch", async () => {
      if (first === "cancelled") controller.abort(new Error("private-test-key"));
      await new Promise(resolve => setTimeout(resolve, 50));
      controller.abort(new Error("private-test-key"));
      throw new Error("private-test-key");
    });
    await assert.rejects(callModel(f.model, messages, { signal: controller.signal }),
      failure(first, "headers", first === "cancelled" ? /取消/ : /超时/));
    mock.mock.restore();
  }
});

test("explicit upstream HTTP status survives a failed error-body cancellation", async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(429);
    res.end("private-test-key");
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await realFetch(...args);
    await response.body.cancel();
    return { ok: false, status: 429, body: { cancel() { return Promise.reject(new Error("private-test-key")); } } };
  });
  await assert.rejects(callModel(f.model, messages), error => {
    failure("upstream_http", "headers", /429/)(error);
    assert.equal(error.upstreamStatus, 429);
    return true;
  });
  assert.equal(f.requests(), 1);
});

test("a null JSON response is an invalid response, not an internal TypeError", async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("null");
  });
  await assert.rejects(callModel(f.model, messages), failure("invalid_response", "body", /消息/));
  assert.equal(f.requests(), 1);
});

test("an absent response body is an invalid response rather than an internal error", async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await assert.rejects(callModel(f.model, messages), failure("invalid_response", "body", /正文/));
  assert.equal(f.requests(), 1);
});

test("oversized response keeps its size-limit diagnostic if reader cancellation fails", async t => {
  const f = await fixture(t, () => {});
  let attempts = 0;
  let released = false;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return { ok: true, body: { getReader: () => ({
      read: async () => ({ value: new Uint8Array(2 * 1024 * 1024 + 1), done: false }),
      cancel: async () => { throw new Error("private-test-key"); },
      releaseLock: () => { released = true; },
    }) } };
  });
  await assert.rejects(callModel(f.model, messages), failure("response_too_large", "body", /2 MB/));
  assert.equal(attempts, 1);
  assert(released);
});
