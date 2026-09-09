#!/usr/bin/env node
// Portable JSON adapter. Policy stays in BAIS; no BI imports or shell commands.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

process.env.BAML_PROFILE ??= '0';
const actions = ['list', 'ready', 'show', 'check', 'graph', 'dispatch'];
function need(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be a JSON object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown field: ${key}`);
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
try {
  if (process.argv.includes('--help')) {
    emit({ actions, input: 'one JSON object on stdin', required: ['action', 'hub'], optional: ['id (show/graph)', 'agents (dispatch)'], runtime: 'BAIS_HOME or owning checkout; built BAIS host and bridge, no BI' });
  } else {
    const req = JSON.parse(readFileSync(0, 'utf8'));
    fields(req, ['action', 'hub', 'id', 'agents']);
    if (!actions.includes(req.action)) throw new Error(`unknown action: ${req.action}`);
    if (req.id !== undefined && !['show', 'graph'].includes(req.action)) throw new Error('id is only valid for show/graph');
    if (req.agents !== undefined && req.action !== 'dispatch') throw new Error('agents is only valid for dispatch');
    const hub = realpathSync(resolve(need(req.hub, 'hub')));
    // Explicit target: never let the CLI fall back to a parent or sibling board.
    if (!existsSync(join(hub, '.bais', 'config.toml')) || !existsSync(join(hub, '.bais', 'issues'))) {
      throw new Error(`missing board at ${hub}/.bais (config.toml and issues required)`);
    }
    const home = resolve(process.env.BAIS_HOME || join(dirname(fileURLToPath(import.meta.url)), '../../..'));
    const cli = join(home, 'dist/src/cli.js');
    if (!existsSync(cli)) throw new Error(`BAIS build missing: set BAIS_HOME to its checkout and run npm run build there (${cli})`);
    if (['show', 'graph'].includes(req.action)) need(req.id, 'id');
    if (req.action === 'show') {
      const { loadIssues } = await import(pathToFileURL(join(home, 'dist/src/graph.js')).href);
      const { issues, failures } = await loadIssues(join(hub, '.bais/issues'));
      const matches = issues.filter(f => f.issue.id === req.id);
      const ok = matches.length === 1 && failures.length === 0;
      emit({ ok, action: req.action, hub, data: { issue: matches.length === 1 ? matches[0] : null, unparseable: failures, source: 'files' },
        ...(!ok ? { error: { code: 'incomplete-read', message: matches.length === 0 ? `unknown issue: ${req.id}` : matches.length > 1 ? `duplicate issue: ${req.id}` : 'board contains unparseable files' } } : {}) });
      if (!ok) process.exitCode = 1;
    } else {
      const args = [cli, req.action, '--json'];
      if (req.action === 'graph') args.push('--from', req.id);
      if (req.action === 'dispatch') {
        if (!Number.isSafeInteger(req.agents) || req.agents < 1) throw new Error('agents must be a positive integer');
        args.push('--agents', String(req.agents));
      }
      const result = spawnSync(process.execPath, args, { cwd: hub, env: process.env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const diagnostics = result.stderr || '';
      let data = null;
      try { data = JSON.parse(result.stdout); } catch { /* Invalid stdout is an explicit error below. */ }
      const incomplete = Array.isArray(data?.unparseable) && data.unparseable.length > 0;
      const ok = !result.error && result.status === 0 && data !== null && !incomplete;
      emit({ ok, action: req.action, hub, data, diagnostics, exit_code: result.status,
        ...(!ok ? { error: { code: incomplete ? 'incomplete-read' : result.error ? 'execution-failed' : data === null ? 'invalid-cli-json' : 'bais-failed',
          message: incomplete ? 'board contains unparseable files; inspect data.unparseable' : result.error?.message || diagnostics.trim() || `BAIS exited ${result.status}` },
          ...(data === null ? { stdout: result.stdout || '' } : {}) } : {}) });
      if (!ok) process.exitCode = 1;
    }
  }
} catch (error) {
  emit({ ok: false, error: { code: 'request-failed', message: String(error.message || error) } });
  process.exitCode = 1;
}
