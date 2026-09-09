// Executed red checks 2026-09-09, each source hunk changed alone and rebuilt:
// - expect-hash guard disabled -> FAIL stale-hash-rejects-without-changing-file.
// - live-holder guard disabled -> FAIL live-claim-requires-owner-and-survives-edit-with-edges.
// - incomplete-board guard disabled -> FAIL malformed-board-blocks-writes.
// - ingest replaced with a fake success -> FAIL existing-projection-refreshed-after-write.
// Each exited 1 for that named assertion. Restored source + rebuild: 16 PASS;
// subsequent CLI routing regression cases extend the suite to 18 checks.
// Native authoring acceptance: temporary boards, actual CLI, offline BAML validator.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const cli = resolve(import.meta.dirname, '../dist/src/cli.js');
const root = mkdtempSync(join(tmpdir(), 'bais-authoring-'));
const issues = join(root, '.bais/issues');
const env = { ...process.env, BAML_PROFILE: '0' };
let passed = 0;
function call(args, input) {
 const r = spawnSync(process.execPath, [cli, ...args, '--hub', root, '--json'], { cwd: tmpdir(), env, input, encoding: 'utf8', timeout: 60000 });
 assert.ifError(r.error);
 return { status: r.status, data: JSON.parse(r.stdout), stderr: r.stderr };
}
function good(args, input) { const r = call(args, input); assert.equal(r.status, 0, JSON.stringify(r)); return r.data; }
function bad(args, pattern) { const r = call(args); assert.equal(r.status, 1, JSON.stringify(r)); assert.match(r.data.error, pattern); }
function test(name, fn) { try { fn(); } catch (e) { throw new Error(`FAIL ${name}: ${e.message}`, { cause: e }); } passed++; console.log(`PASS ${name}`); }
try {
 mkdirSync(issues, { recursive: true });
 writeFileSync(join(root, '.bais/config.toml'), 'project = "fixture"\n');
 const body = 'Quotes " and \'\'\', regex \\d, unicode λ\nFiles: src/test.ts\n';
 let created;
 test('native-new-auto-id-and-body-roundtrip', () => {
  created = good(['new', 'Native title', '--body', body, '--kind', 'Bug', '--severity', '2']);
  assert.equal(created.issue.issue.id, 'fixture#1'); assert.equal(created.issue.issue.body, body);
  assert.equal(created.issue.issue.status, 'Open'); assert.equal(created.issue.issue.kind, 'Bug');
 });
 const file = join(issues, 'fixture#1.toml');
 test('show-returns-content-hash-and-full-record', () => {
  const shown = good(['show', 'fixture#1']); assert.equal(shown.content_hash, created.content_hash);
  assert.equal(shown.issue.issue.body, body); assert.equal(shown.issue.holder, null);
 });
 test('duplicate-new-never-overwrites', () => {
  const before = readFileSync(file, 'utf8'); bad(['new', 'Overwrite', '--id', 'fixture#1'], /already exists/);
  assert.equal(readFileSync(file, 'utf8'), before);
 });
 test('invalid-fields-write-nothing', () => {
  const before = readdirSync(issues).sort();
  bad(['new', 'Bad', '--kind', 'Typo'], /kind|Kind|serialization/);
  bad(['new', 'Bad', '--severity', '0'], /severity/);
  bad(['edit', 'fixture#1', '--status', 'Done'], /unsupported option/);
  bad(['edit', 'fixture#1', '--title'], /missing value/);
  assert.deepEqual(readdirSync(issues).sort(), before);
 });
 test('path-escape-rejected', () => bad(['new', 'Bad', '--id', '../escape'], /id must/));
 test('append-and-footprints-preserve-content', () => {
  const changed = good(['edit', 'fixture#1', '--append-body', 'Evidence: drill(issue-commands-fixture)', '--files', 'src/next.ts', '--files', 'src/next.ts', '--expect-hash', created.content_hash]);
  assert.ok(changed.issue.issue.body.startsWith(body));
  assert.equal(changed.issue.issue.body.split('Files: src/next.ts').length, 2);
  assert.match(changed.issue.issue.body, /Evidence: drill/);
 });
 test('stale-hash-rejects-without-changing-file', () => {
  const before = readFileSync(file, 'utf8'); bad(['edit', 'fixture#1', '--title', 'Stale', '--expect-hash', created.content_hash], /hash mismatch/);
  assert.equal(readFileSync(file, 'utf8'), before);
 });
 test('stdin-body-and-local-file-body', () => {
  const text = '\nstarts with newline\nends with quote\'';
  good(['new', 'Stdin', '--body-file', '-'], text);
  const source = join(root, 'body.md'); writeFileSync(source, text);
  const changed = good(['edit', 'fixture#2', '--body-file', source]); assert.equal(changed.issue.issue.body, text);
  const appended = good(['edit', 'fixture#2', '--append-body-file', source]); assert.equal(appended.issue.issue.body, text+'\n\n'+text);
 });
 test('relative-body-file-keeps-invoking-cwd', () => {
  const caller = join(root, 'caller'); mkdirSync(caller);
  writeFileSync(join(caller, 'relative.md'), 'From caller directory');
  const r = spawnSync(process.execPath, [cli, 'edit', 'fixture#2', '--body-file', 'relative.md', '--hub', root, '--json'], { cwd: caller, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout+r.stderr);
  assert.equal(JSON.parse(r.stdout).issue.issue.body, 'From caller directory');
 });
 test('remote-hub-option-keeps-existing-meaning', () => {
  const r = spawnSync(process.execPath, [cli, 'grant', '--hub', 'https://example.invalid', '--help'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stdout, /bais grant/);
 });
 test('ambiguous-body-options-rejected', () => bad(['edit', 'fixture#1', '--body', 'x', '--append-body', 'y'], /choose one body/));
 test('live-claim-requires-owner-and-survives-edit-with-edges', () => {
  writeFileSync(file, readFileSync(file, 'utf8').replace('status = "Open"','status = "Doing"')+'\nholder = "agent-a"\nlease = "2099-01-01T00:00:00Z"\n\n[[edge]]\nfrom = "fixture#1"\nto = "fixture#2"\nkind = "Related"\n');
  const before = readFileSync(file, 'utf8');
  bad(['edit', 'fixture#1', '--title', 'Stolen'], /live claim held by agent-a/);
  assert.equal(readFileSync(file, 'utf8'), before);
  const changed = good(['edit', 'fixture#1', '--title', 'Owned edit', '--as', 'agent-a']);
  assert.equal(changed.issue.holder, 'agent-a'); assert.equal(changed.issue.lease, '2099-01-01T00:00:00Z');
  assert.equal(changed.issue.issue.status, 'Doing'); assert.equal(changed.issue.edges[0].kind, 'Related');
 });
 test('writer-lock-is-respected', () => {
  writeFileSync(file+'.lock', '');
  bad(['edit', 'fixture#1', '--title', 'Locked', '--as', 'agent-a'], /EEXIST/);
  rmSync(file+'.lock');
 });
 test('archive-numbers-not-reused', () => {
  mkdirSync(join(root, '.bais/archive')); writeFileSync(join(root, '.bais/archive/fixture#10.toml'), 'archived');
  assert.equal(good(['new', 'Next']).issue.issue.id, 'fixture#11');
 });
 test('malformed-board-blocks-writes', () => {
  writeFileSync(join(issues, 'bad.toml'), 'not toml');
  bad(['new', 'Incomplete'], /incomplete board/); rmSync(join(issues, 'bad.toml'));
 });
 test('explicit-hub-never-falls-back-to-parent', () => {
  const child=join(root,'child'); mkdirSync(child);
  const r=spawnSync(process.execPath,[cli,'show','fixture#1','--hub',child,'--json'],{cwd:root,env,encoding:'utf8'});
  assert.equal(r.status,1); assert.match(JSON.parse(r.stdout).error,/missing board/);
 });
 test('existing-projection-refreshed-after-write', () => {
  good(['ingest']);
  const edited=good(['edit','fixture#2','--title','Fresh projection']); assert.equal(edited.projection,'rebuilt');
  const listed=good(['list']); assert.ok(JSON.stringify(listed).includes('Fresh projection'));
 });
 // Concurrent native writers must never silently overwrite the same explicit id.
 const concurrent = () => new Promise(resolveRun => {
  const child=spawn(process.execPath,[cli,'new','Concurrent','--id','fixture#99','--hub',root,'--json'],{env});
  let out=''; child.stdout.on('data',b=>out+=b); child.stderr.resume();
  child.on('close',status=>resolveRun({status,data:JSON.parse(out)}));
 });
 const races=await Promise.all([concurrent(),concurrent()]);
 assert.deepEqual(races.map(r=>r.status).sort(),[0,1]);
 assert.equal(good(['show','fixture#99']).issue.issue.title,'Concurrent');
 passed++; console.log('PASS concurrent-create-has-one-winner');
 console.log(`PASS ${passed} native issue command checks`);
} finally { rmSync(root, { recursive: true, force: true }); }
