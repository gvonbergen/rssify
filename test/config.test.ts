import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configGet, configSet, DEFAULT_CONFIG, loadConfig, loadEnvFile } from '../src/config.ts';
import { makeTempDir, removeTempDir } from './helpers.ts';

test('loadEnvFile parses comments, whitespace, quoted values, and malformed lines', async () => {
  const dir = await makeTempDir();
  try {
    const path = join(dir, '.env');
    await writeFile(path, '# comment\n A = "hello world"\nB=\'quoted\'\nNO_EQUALS\nEMPTY=\n', 'utf8');
    assert.deepEqual(loadEnvFile(path), { A: 'hello world', B: 'quoted', EMPTY: '' });
    assert.deepEqual(loadEnvFile(join(dir, 'missing')), {});
  } finally {
    await removeTempDir(dir);
  }
});

test('loadConfig deep-merges isolated YAML and expands only supplied environment values', async () => {
  const dir = await makeTempDir();
  try {
    const configPath = join(dir, 'nested', 'config.yaml');
    const envPath = join(dir, 'nested', '.env');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(configPath, 'server:\n  port: 4321\n  domain: ${TEST_DOMAIN}\ndefaults:\n  follow: false\nai:\n  model: local-model\n', 'utf8');
    await writeFile(envPath, 'TEST_DOMAIN=feeds.example.test\n', 'utf8');
    const config = loadConfig({ configPath, envPath });
    assert.equal(config.server.port, 4321);
    assert.equal(config.server.host, DEFAULT_CONFIG.server.host);
    assert.equal(config.server.domain, 'feeds.example.test');
    assert.equal(config.defaults.follow, false);
    assert.equal(config.defaults.feed_item_limit, DEFAULT_CONFIG.defaults.feed_item_limit);
    assert.equal(config.ai.model, 'local-model');
    assert.equal(config.storage.db_path, DEFAULT_CONFIG.storage.db_path);
    assert.equal(configGet('server.domain', { configPath, envPath }), 'feeds.example.test');
    assert.equal(configGet('does.not.exist', { configPath, envPath }), undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test('configSet routes known secrets to an isolated env file and coerces ordinary values', async () => {
  const dir = await makeTempDir();
  try {
    const configPath = join(dir, 'config.yaml');
    const envPath = join(dir, '.env');
    await writeFile(configPath, 'server:\n  host: 0.0.0.0\n', 'utf8');
    await writeFile(envPath, 'EXISTING=value\n', 'utf8');

    assert.equal(configSet('backends.firecrawl.api_key', 'secret-value', { configPath, envPath }), 'FIRECRAWL_API_KEY');
    const env = await readFile(envPath, 'utf8');
    assert.match(env, /EXISTING=value/);
    assert.match(env, /FIRECRAWL_API_KEY=secret-value/);
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /secret-value/);

    assert.equal(configSet('server.port', '8080', { configPath, envPath }), null);
    assert.equal(configSet('defaults.follow', 'false', { configPath, envPath }), null);
    const config = loadConfig({ configPath, envPath });
    assert.equal(config.server.port, 8080);
    assert.equal(config.defaults.follow, false);
    assert.throws(() => configSet('custom.api_key', 'must-not-be-written', { configPath, envPath }), /No known secret env var/);
  } finally {
    await removeTempDir(dir);
  }
});

test('loadConfig surfaces malformed YAML instead of silently using unsafe defaults', async () => {
  const dir = await makeTempDir();
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'server: [unclosed\n', 'utf8');
    assert.throws(() => loadConfig({ configPath, envPath: join(dir, '.env') }));
  } finally {
    await removeTempDir(dir);
  }
});
