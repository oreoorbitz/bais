// Executed red-checks (2026-09-08), isolated mutant copies via PORTABLE_HELPER:
// missing-board guard removed: exit 1, AssertionError "missing-hub must fail instead of reading parent".
// incomplete-read flag removed: exit 1, AssertionError "incomplete-read must fail".
// Original helper unchanged; full fixture rerun green after all mutations.
// Portable skill regression: real BAIS runtime from an unrelated cwd.
// Red checks recorded after execution below; temporary boards never touch the live hub.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(process.env.PORTABLE_HELPER || join(home, 'skills/bais/scripts/bais-json.mjs'));
const root = mkdtempSync(join(tmpdir(), 'bais-portable-'));
let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
function call(req) {
  const r = spawnSync(process.execPath, [helper], { cwd: root, env: { ...process.env, BAIS_HOME: home, BAML_PROFILE: '0' }, input: JSON.stringify(req), encoding: 'utf8', timeout: 70000 });
  assert.ifError(r.error);
  return { status: r.status, body: JSON.parse(r.stdout) };
}
try {
  mkdirSync(join(root, '.bais/issues'), { recursive: true });
  writeFileSync(join(root, '.bais/config.toml'), 'project = "portable"\n');
  const issue = `id = "portable#1"\ntitle = "Inspect portable adapter"\nstatus = "Open"\nkind = "Feat"\nbody = '''Read this literal body.\nFiles: sample.txt\n'''\n`;
  writeFileSync(join(root, '.bais/issues/portable#1.toml'), issue);
  test('ready-from-unrelated-cwd', () => {
    const r = call({ action: 'ready', hub: root });
    assert.equal(r.status, 0); assert.equal(r.body.ok, true);
    assert.equal(r.body.data.ready[0].issue.id, 'portable#1');
  });
  test('show-literal-body', () => {
    const r = call({ action: 'show', hub: root, id: 'portable#1' });
    assert.equal(r.status, 0); assert.match(r.body.data.issue.issue.body, /literal body/);
  });
  test('missing-hub-never-falls-back', () => {
    const child = join(root, 'child'); mkdirSync(child);
    const r = call({ action: 'list', hub: child });
    assert.equal(r.status, 1, 'missing-hub must fail instead of reading parent');
    assert.match(r.body.error.message, /missing board/);
  });
  test('unknown-issue-is-error', () => assert.equal(call({ action: 'show', hub: root, id: 'missing' }).status, 1));
  test('typo-is-error', () => assert.equal(call({ action: 'ready', hub: root, hubs: root }).status, 1));
  test('parse-failure-retains-partial-data', () => {
    writeFileSync(join(root, '.bais/issues/bad.toml'), 'not toml');
    const r = call({ action: 'list', hub: root });
    assert.equal(r.status, 1, 'incomplete-read must fail');
    assert.equal(r.body.error.code, 'incomplete-read');
    assert.equal(r.body.data.issues[0].issue.id, 'portable#1');
    assert.equal(r.body.data.unparseable.length, 1);
  });
  rmSync(join(root, '.bais/issues/bad.toml'));
  test('dispatch-is-dry-run-json', () => {
    const r = call({ action: 'dispatch', hub: root, agents: 1 });
    assert.equal(r.status, 0); assert.equal(r.body.ok, true);
    assert.equal(call({ action: 'show', hub: root, id: 'portable#1' }).body.data.issue.issue.status, 'Open');
  });
  test('claims-survive-show', () => {
    writeFileSync(join(root, '.bais/issues/claimed.toml'), 'id = "portable#2"\ntitle = "Claimed"\nstatus = "Doing"\nkind = "Feat"\nbody = "Files: other.txt"\nholder = "outside-agent"\nlease = "2099-01-01T00:00:00Z"\n');
    const r = call({ action: 'show', hub: root, id: 'portable#2' });
    assert.equal(r.status, 0); assert.equal(r.body.data.issue.holder, 'outside-agent');
    assert.equal(r.body.data.issue.lease, '2099-01-01T00:00:00Z');
  });
  test('graph-json', () => {
    const r = call({ action: 'graph', hub: root, id: 'portable#1' });
    assert.equal(r.status, 0); assert.equal(r.body.ok, true);
  });
  test('failed-check-retains-report', () => {
    writeFileSync(join(root, '.bais/issues/portable#1.toml'), issue + '\n[[edge]]\nfrom = "portable#1"\nto = "portable#1"\nkind = "Blocks"\n');
    const r = call({ action: 'check', hub: root });
    assert.equal(r.status, 1); assert.equal(r.body.exit_code, 1);
    assert.ok(r.body.data, 'nonzero check report must survive');
  });
  test('portable-copy', () => {
    const copy = join(root, 'copied.mjs'); cpSync(helper, copy);
    const r = spawnSync(process.execPath, [copy], { cwd: root, env: { ...process.env, BAIS_HOME: home, BAML_PROFILE: '0' }, input: JSON.stringify({ action: 'show', hub: root, id: 'portable#1' }), encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).data.issue.issue.id, 'portable#1');
  });
  console.log(`PASS ${count} portable BAIS checks`);
} finally { rmSync(root, { recursive: true, force: true }); }
