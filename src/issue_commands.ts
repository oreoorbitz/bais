// Native issue authoring for shell-capable agents. BAML owns TOML encoding
// and validation; this module owns arguments, files, and write coordination.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadIssues, projectName, type BaisFile } from "./graph.js";
import { parseBaisFile, serializeBaisFile } from "./toml.js";
import { hasStore, ingestIssues } from "./store.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
function fail(message: string): never { throw new Error(message); }
function validId(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*#[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail("id must be project#name using letters, digits, dot, underscore or hyphen");
	return id;
}
function parseArgs(args: string[], command: string) {
	const allowed = command === "show" ? [] : ["--kind", "--area", "--severity", "--source", "--body", "--body-file", "--files",
		...(command === "new" ? ["--id"] : ["--title", "--append-body", "--append-body-file", "--as", "--expect-hash"])];
	const values = new Map<string, string[]>(), positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") continue;
		if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
		if (!arg.startsWith("--")) { positional.push(arg); continue; }
		if (!allowed.includes(arg)) fail(`unsupported option for ${command}: ${arg}`);
		if (i + 1 === args.length || args[i + 1].startsWith("--")) fail(`missing value for ${arg}`);
		if (values.has(arg) && arg !== "--files") fail(`duplicate option: ${arg}`);
		values.set(arg, [...(values.get(arg) ?? []), args[++i]]);
	}
	if (positional.length !== 1 || !positional[0].trim()) fail(`usage: bais ${command} ${command === "new" ? '"title"' : '<id>'} [options]`);
	const get = (key: string) => values.get(key)?.[0];
	const bodyKeys = ["--body", "--body-file", "--append-body", "--append-body-file"].filter(k => values.has(k));
	if (bodyKeys.length > 1) fail("choose one body option: --body, --body-file, --append-body, --append-body-file");
	return { values, get, target: positional[0] };
}

async function validatedText(record: BaisFile): Promise<string> {
	const text: string = await serializeBaisFile(record);
	const parsed = await parseBaisFile(text);
	// Do not write if a bridge/serializer roundtrip silently changes data.
	if (JSON.stringify(parsed) !== JSON.stringify(record)) fail("BAML serialization changed issue data; no file written");
	return text;
}

export async function runIssueCommand(command: string, args: string[], issuesDir: string) {
	const { values, get, target } = parseArgs(args, command);
	if (!existsSync(issuesDir) || !existsSync(join(issuesDir, "..", "config.toml"))) fail("missing board: config.toml and issues directory required");
	const loaded = await loadIssues(issuesDir);
	if (loaded.failures.length) fail(`incomplete board: ${loaded.failures.map(f => f.file).join(", ")}; repair unparseable files first`);
	const ids = loaded.issues.map(f => f.issue.id);
	if (new Set(ids).size !== ids.length) fail("duplicate issue ids in board; repair before proceeding");
	let id = command === "new" ? get("--id") : validId(target);
	if (id !== undefined) validId(id);
	if (command === "new" && !id) {
		const project = projectName(issuesDir);
		validId(`${project}#1`);
		const archiveDir = join(issuesDir, "..", "archive");
		const names = [...ids, ...readdirSync(issuesDir).map(n => n.replace(/\.toml$/, "")),
			...(existsSync(archiveDir) ? readdirSync(archiveDir).map(n => n.replace(/\.toml$/, "")) : [])];
		let max = 0;
		for (const name of names) {
			if (!name.startsWith(`${project}#`)) continue;
			const suffix = name.slice(project.length + 1);
			if (/^\d+$/.test(suffix)) {
				const n = Number(suffix);
				if (!Number.isSafeInteger(n) || n >= Number.MAX_SAFE_INTEGER) fail("numeric id space exhausted; use --id");
				max = Math.max(max, n);
			}
		}
		id = `${project}#${max + 1}`;
	}
	const file = join(issuesDir, `${id!}.toml`);
	if (command === "show") {
		if (!existsSync(file)) fail(`unknown issue: ${id}`);
		const original = readFileSync(file, "utf8"), record = await parseBaisFile(original);
		if (record.issue.id !== id) fail("issue id does not match filename");
		return { ok: true, issue: record, file, content_hash: hash(original), source: "files" };
	}
	// One writer per issue. Exclusive creation protects new ids; the edit lock
	// coordinates these commands, while byte comparison detects intervening
	// external writes during the asynchronous parser/serializer work.
	let lock: number | undefined, temp: string | undefined, written = false;
	const lockFile = `${file}.lock`;
	try {
		lock = openSync(lockFile, "wx");
		let original = "", record: BaisFile;
		if (command === "new") {
			if (ids.includes(id!) || existsSync(file) || existsSync(join(issuesDir, "..", "archive", `${id}.toml`))) fail(`issue already exists: ${id}`);
			record = { issue: { id: id!, title: target, status: "Open", kind: "Feat", area: null, severity: null, source: null, body: "" }, edges: [], holder: null, lease: null };
		} else {
			if (!existsSync(file)) fail(`unknown issue: ${id}`);
			if (!lstatSync(file).isFile()) fail("edit requires a regular issue file; symlinks are not supported");
			original = readFileSync(file, "utf8");
			record = await parseBaisFile(original);
			if (record.issue.id !== id) fail("issue id does not match filename");
			if (get("--expect-hash") !== undefined && get("--expect-hash") !== hash(original)) fail("content hash mismatch: read show again before editing");
			if (record.holder && record.lease && Date.parse(record.lease) > Date.now() && get("--as") !== record.holder) fail(`live claim held by ${record.holder}; edit requires matching --as`);
			if (![...values.keys()].some(k => !["--as", "--expect-hash"].includes(k))) fail("edit requires at least one changed field or body option");
		}
		for (const key of ["title", "kind", "area", "source"] as const) {
			const value = get(`--${key}`);
			if (value !== undefined) {
				if (!value.trim() && (key === "title" || key === "kind")) fail(`${key} must not be empty`);
				record.issue[key] = value;
			}
		}
		if (get("--severity") !== undefined) {
			const value = get("--severity")!;
			if (!/^[1-5]$/.test(value)) fail("severity must be an integer from 1 to 5");
			record.issue.severity = Number(value);
		}
		const bodyFile = get("--body-file") ?? get("--append-body-file");
		const body = bodyFile !== undefined ? readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8") : get("--body") ?? get("--append-body");
		if (body !== undefined) record.issue.body = values.has("--append-body") || values.has("--append-body-file")
			? [record.issue.body, body].filter(Boolean).join("\n\n") : body;
		for (const path of values.get("--files") ?? []) {
			if (!path.trim() || /[\r\n]/.test(path)) fail("--files requires a nonempty single-line footprint");
			const line = `Files: ${path}`;
			if (!record.issue.body.split("\n").includes(line)) record.issue.body = [record.issue.body, line].filter(Boolean).join("\n");
		}
		const text = await validatedText(record);
		if (command === "new") writeFileSync(file, text, { flag: "wx" });
		else {
			if (!lstatSync(file).isFile() || readFileSync(file, "utf8") !== original) fail("issue changed during edit; read show again and retry");
			const candidate = `${file}.edit-${process.pid}`;
			writeFileSync(candidate, text, { flag: "wx", mode: lstatSync(file).mode & 0o777 });
			temp = candidate;
			renameSync(temp, file); temp = undefined;
		}
		written = true;
		const projection = hasStore(issuesDir) ? await ingestIssues(issuesDir) : null;
		if (projection && projection.failures > 0) fail("projection rebuild found unparseable files; repair board and run ingest");
		return { ok: true, action: command, issue: record, file, content_hash: hash(text), projection: projection ? "rebuilt" : "absent" };
	} catch (error) {
		const message = (error as Error).message;
		throw new Error(written ? `issue written to ${file}, but ${message}; run bais ingest before projection reads` : message);
	} finally {
		if (temp && existsSync(temp)) unlinkSync(temp);
		if (lock !== undefined) { closeSync(lock); unlinkSync(lockFile); }
	}
}
