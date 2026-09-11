import test from 'node:test';
import assert from 'node:assert/strict';
import { envVar, deprecatedEnvNames, resetDeprecatedEnvNames } from '../host/env.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetDeprecatedEnvNames();
  }
}

test('envVar reads the AUTOPILOT_ name', () => {
  withEnv({ AUTOPILOT_ENVTEST_A: 'new', CHROME_MCP_ENVTEST_A: 'old' }, () => {
    assert.equal(envVar('ENVTEST_A'), 'new');
    assert.deepEqual(deprecatedEnvNames(), []);
  });
});

test('envVar falls back to the CHROME_MCP_ name and reports it as deprecated', () => {
  withEnv({ AUTOPILOT_ENVTEST_B: undefined, CHROME_MCP_ENVTEST_B: 'old' }, () => {
    assert.equal(envVar('ENVTEST_B'), 'old');
    assert.deepEqual(deprecatedEnvNames(), ['CHROME_MCP_ENVTEST_B']);
  });
});

test('envVar returns undefined when neither name is set', () => {
  withEnv({ AUTOPILOT_ENVTEST_C: undefined, CHROME_MCP_ENVTEST_C: undefined }, () => {
    assert.equal(envVar('ENVTEST_C'), undefined);
  });
});

test('an empty AUTOPILOT_ value still wins over the old name', () => {
  withEnv({ AUTOPILOT_ENVTEST_D: '', CHROME_MCP_ENVTEST_D: 'old' }, () => {
    assert.equal(envVar('ENVTEST_D'), '');
  });
});

test('deprecatedEnvNames scans the environment for old names nothing has read yet', () => {
  withEnv({ CHROME_MCP_ENVTEST_E: '1', CHROME_MCP_ENVTEST_F: '2', AUTOPILOT_ENVTEST_F: '3' }, () => {
    const names = deprecatedEnvNames();
    assert.ok(names.includes('CHROME_MCP_ENVTEST_E'), 'unshadowed old name is reported');
    assert.ok(!names.includes('CHROME_MCP_ENVTEST_F'), 'an old name with a new counterpart is not');
    assert.deepEqual(names, [...names].sort(), 'sorted, so the log line is stable');
  });
});

test('resetDeprecatedEnvNames forgets what was read', () => {
  withEnv({ CHROME_MCP_ENVTEST_G: 'old' }, () => {
    envVar('ENVTEST_G');
    assert.ok(deprecatedEnvNames().includes('CHROME_MCP_ENVTEST_G'));
    delete process.env.CHROME_MCP_ENVTEST_G;
    assert.ok(deprecatedEnvNames().includes('CHROME_MCP_ENVTEST_G'), 'remembered from the read');
    resetDeprecatedEnvNames();
    assert.ok(!deprecatedEnvNames().includes('CHROME_MCP_ENVTEST_G'));
  });
});
