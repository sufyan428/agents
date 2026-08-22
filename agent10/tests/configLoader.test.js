const test = require('node:test');
const assert = require('node:assert');
const configLoader = require('../src/config/configLoader');

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('resolveProvider: explicit config wins over env', () => {
  withEnv({ OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: undefined }, () => {
    assert.strictEqual(configLoader.resolveProvider('anthropic'), 'anthropic');
  });
});

test('resolveProvider: auto prefers openrouter when both keys present', () => {
  withEnv({ OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, () => {
    assert.strictEqual(configLoader.resolveProvider('auto'), 'openrouter');
  });
});

test('resolveProvider: auto falls back to anthropic when only that key is set', () => {
  withEnv({ OPENROUTER_API_KEY: undefined, ANTHROPIC_API_KEY: 'y' }, () => {
    assert.strictEqual(configLoader.resolveProvider('auto'), 'anthropic');
  });
});

test('resolveProvider: auto is null when neither key is set', () => {
  withEnv({ OPENROUTER_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => {
    assert.strictEqual(configLoader.resolveProvider('auto'), null);
  });
});
