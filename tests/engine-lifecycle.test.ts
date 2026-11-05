import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRuntime } from '../src/agent.js';
import { AgentEngine } from '../src/engine.js';
import { config, deferred } from './helpers.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function runtime(dispose: AgentRuntime['dispose'] = () => {}): AgentRuntime {
  return { receive: async () => 'ready', dispose };
}

test('failed loading can be retried without retaining a lifecycle operation', async (t) => {
  let attempts = 0;
  const engine = new AgentEngine({
    load: async () => {
      if (++attempts === 1) throw new Error('private loading detail');
      return runtime();
    },
  });
  t.after(() => engine.close());
  engine.registerAgent(config());
  await assert.rejects(engine.startAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(engine.getAgent('a').status, 'start_failed');
  assert.deepEqual(engine.getAgent('a').error, {
    code: 'RUNTIME_ERROR', message: 'Agent runtime failed',
  });
  assert.equal((await engine.startAgent('a')).status, 'running');
  assert.equal(engine.getAgent('a').error, undefined);
});

test('failed stopping blocks startup until the retained runtime is cleaned up', async (t) => {
  let loads = 0;
  let disposals = 0;
  const engine = new AgentEngine({
    load: async () => {
      loads++;
      return runtime(() => {
        if (++disposals === 1) throw new Error('private cleanup detail');
      });
    },
  });
  t.after(() => engine.close());
  engine.registerAgent(config());
  await engine.startAgent('a');
  await assert.rejects(engine.stopAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(engine.getAgent('a').status, 'stop_failed');
  await assert.rejects(engine.startAgent('a'), { code: 'AGENT_CLEANUP_REQUIRED' });
  assert.equal(loads, 1, 'must not replace a runtime whose cleanup failed');
  assert.equal((await engine.stopAgent('a')).status, 'stopped');
  assert.equal(disposals, 2, 'retry must use the retained runtime');
  assert.equal(engine.getAgent('a').error, undefined);
  await engine.startAgent('a');
  assert.equal(loads, 2);
});

test('stopping during loading waits for cleanup and cancels the startup request', async (t) => {
  const loaded = deferred<AgentRuntime>();
  const disposing = deferred<void>();
  const release = deferred<void>();
  const engine = new AgentEngine({ load: () => loaded.promise });
  t.after(() => engine.close());
  engine.registerAgent(config());
  const started = assert.rejects(engine.startAgent('a'), { code: 'AGENT_STOPPED' });
  const stopped = engine.stopAgent('a');
  assert.equal(engine.getAgent('a').status, 'stopping');
  await assert.rejects(engine.startAgent('a'), { code: 'AGENT_BUSY' });
  let finished = false;
  void stopped.then(() => { finished = true; }, () => {});
  loaded.resolve(runtime(async () => {
    disposing.resolve();
    await release.promise;
  }));
  await disposing.promise;
  assert.equal(engine.getAgent('a').status, 'stopping');
  assert.equal(finished, false);
  release.resolve();
  assert.equal((await stopped).status, 'stopped');
  await started;
  assert.equal(engine.getAgent('a').error, undefined);
});

test('stopping a cancelled load succeeds even when the loader rejects', async (t) => {
  const release = deferred<void>();
  const engine = new AgentEngine({ load: async () => {
    await release.promise;
    throw new Error('private loading detail');
  } });
  t.after(() => engine.close());
  engine.registerAgent(config());
  const started = assert.rejects(engine.startAgent('a'), { code: 'AGENT_STOPPED' });
  const stopped = engine.stopAgent('a');
  release.resolve();
  await Promise.all([started, stopped]);
  assert.equal(engine.getAgent('a').status, 'stopped');
  assert.equal(engine.getAgent('a').error, undefined);
});

test('close shares its result and waits for a late load to finish cleanup', async () => {
  const loaded = deferred<AgentRuntime>();
  const disposing = deferred<void>();
  const release = deferred<void>();
  let disposals = 0;
  const engine = new AgentEngine({ load: () => loaded.promise });
  engine.registerAgent(config());
  const started = assert.rejects(engine.startAgent('a'), { code: 'CLOSED' });
  const closed = engine.close();
  assert.equal(engine.close(), closed);
  let finished = false;
  void closed.then(() => { finished = true; }, () => {});
  await tick();
  assert.equal(finished, false, 'close must wait for in-flight loading');
  loaded.resolve(runtime(async () => {
    disposals++;
    disposing.resolve();
    await release.promise;
  }));
  await disposing.promise;
  assert.equal(finished, false, 'close must also wait for disposal');
  assert.equal(engine.getAgent('a').status, 'stopping');
  release.resolve();
  await Promise.all([started, closed]);
  assert.equal(engine.getAgent('a').status, 'stopped');
  assert.equal(disposals, 1);
  await assert.rejects(engine.startAgent('a'), { code: 'CLOSED' });
});

test('concurrent stops and close join the existing cleanup instead of disposing twice', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let disposals = 0;
  const engine = new AgentEngine({ load: async () => runtime(async () => {
    disposals++;
    entered.resolve();
    await release.promise;
  }) });
  engine.registerAgent(config());
  await engine.startAgent('a');
  const first = engine.stopAgent('a');
  await entered.promise;
  const second = engine.stopAgent('a');
  const closed = engine.close();
  let finished = false;
  void closed.then(() => { finished = true; }, () => {});
  await tick();
  assert.equal(finished, false);
  release.resolve();
  await Promise.all([first, second, closed]);
  assert.equal(disposals, 1);
  assert.equal(engine.getAgent('a').status, 'stopped');
});

test('close reports safe cleanup failures after attempting every agent', async () => {
  let retry = false;
  const cleaned: string[] = [];
  const engine = new AgentEngine({ load: async (agent) => runtime(() => {
    if (agent.id === 'a' && !retry) throw new Error('secret cleanup detail');
    cleaned.push(agent.id);
  }) });
  engine.registerAgent(config('a'));
  engine.registerAgent(config('b'));
  await engine.startAgent('a');
  await engine.startAgent('b');
  const closed = engine.close();
  await assert.rejects(closed, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].code, 'RUNTIME_ERROR');
    assert.doesNotMatch(error.errors[0].message, /secret/);
    return true;
  });
  assert.equal(engine.close(), closed, 'a repeated close must not hide a failed result');
  assert.equal(engine.getAgent('a').status, 'stop_failed');
  assert.equal(engine.getAgent('b').status, 'stopped');
  assert.deepEqual(cleaned, ['b']);
  retry = true;
  await engine.stopAgent('a');
  assert.deepEqual(cleaned, ['b', 'a']);
});

test('failed cleanup after a cancelled startup retains the late runtime for retry', async () => {
  const loaded = deferred<AgentRuntime>();
  let disposals = 0;
  const engine = new AgentEngine({ load: () => loaded.promise });
  engine.registerAgent(config());
  const started = assert.rejects(engine.startAgent('a'), { code: 'RUNTIME_ERROR' });
  const closed = assert.rejects(engine.close(), AggregateError);
  loaded.resolve(runtime(() => {
    if (++disposals === 1) throw new Error('private cleanup detail');
  }));
  await Promise.all([started, closed]);
  assert.equal(engine.getAgent('a').status, 'stop_failed');
  await engine.stopAgent('a');
  assert.equal(disposals, 2);
  assert.equal(engine.getAgent('a').status, 'stopped');
});

test('close invoked from a room shutdown event shares the outer close result', async () => {
  const engine = new AgentEngine({ load: async () => runtime() });
  engine.registerAgent(config());
  await engine.startAgent('a');
  const room = engine.rooms.create(['user:alice', 'agent:a']);
  let reentered: Promise<void> | undefined;
  engine.rooms.subscribe(room.id, 'user:alice', (event) => {
    if (event.type === 'closed') reentered = engine.close();
  });
  const closed = engine.close();
  assert.equal(reentered, closed);
  await closed;
  assert.equal(engine.getAgent('a').status, 'stopped');
});

test('stopping an already stopped agent is idempotent', async (t) => {
  let disposals = 0;
  const engine = new AgentEngine({ load: async () => runtime(() => { disposals++; }) });
  t.after(() => engine.close());
  engine.registerAgent(config());
  assert.equal((await engine.stopAgent('a')).status, 'stopped');
  await engine.startAgent('a');
  await engine.stopAgent('a');
  await engine.stopAgent('a');
  assert.equal(disposals, 1);
});
