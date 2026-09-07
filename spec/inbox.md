# Agent inbox surface (bi#149)

Spawn briefs require agents to re-read issue + inbox on start/resume
(bi#144), and teardown requires the inbox drained-or-requeued (bi#141)
— but no inbox surface existed (found during bi#145: the restart-line
re-read was a no-op). This spec fixes the shape: per-owner queue
directory, a line-oriented message format mirroring the handoff spec
(bi#139, `handoff.md`), operator+lieutenant-only writes, liveness-gated
delivery with loud re-queue, read-and-acknowledge semantics, and the
`handoff --validate` boundary. Enforced by
`../scripts/inbox.mjs` (scripts-lane; the `bais inbox ...` CLI wiring
is specified in that file's header and is out of scope here).

## 1. File layout

```text
.bais/inbox/<owner>/NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.msg
.bais/inbox/_requeue/<owner>/NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.msg
```

- One queue directory per owner, named exactly by owner id
  (`^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$`, same shape as BAIS claim holders
  and handoff `from`/`to`).
- `_requeue/` is the dead-owner reroute area (§5), not a readable
  inbox: only the operator drains or acks it. No agent ever `read`s
  another owner's queue, including `_requeue/`.
- Message files use the bi#139 priority-filename convention —
  `NN` sorts first so `00` reads first — with a `.msg` suffix so the
  two surfaces never collide on suffix. The validator requires `NN`
  to equal the `priority` header and `<sender>` to equal the `from`
  header (otherwise read order or attribution lies).
- Writers MUST publish atomically: write to `<name>.tmp.<pid>` in the
  same directory, fsync, then `rename` over `<name>` (same discipline
  as handoff.md §5 — readers never see a partial message).

Message text shape (same header discipline as handoff.md §1):

```text
id: msg-001
from: operator
to: titan-1
priority: 00
created_at: 2026-09-06T02:00:00Z

<blank line>
<body>
```

- Headers are the consecutive `key: value` lines starting at line 1
  (exactly one colon followed by one space). The block ends at the
  first blank line; everything after is the body.
- Required headers, exactly these five: `id`, `from`, `to`,
  `priority`, `created_at`. Missing, duplicate, malformed, or unknown
  headers are rejected with the offending line number. There is no
  `directed-by`: direction receipts belong to handoff notes, and
  §3 already restricts who may send.

## 2. Header values and body

| Header       | Rule |
|--------------|------|
| `id`         | `^[A-Za-z0-9][A-Za-z0-9#_.-]*$`, e.g. `msg-001` |
| `from`/`to`  | owner id, `^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$` |
| `priority`   | exactly two digits (`^[0-9]{2}$`), `00` highest, first reads first |
| `created_at` | RFC3339 UTC, `...Z` form, e.g. `2026-09-06T02:00:00Z` |

Body: required, non-empty, at most 2000 chars. Inbox messages carry
operational content (restart pointers, re-queue notices, operator
steer) — longer than a handoff note's single 80-char line, but still
bounded so a queue stays drainable at teardown (bi#141). Code travels
by handoff diff, never by inbox.

## 3. Who may write to another's inbox

**Only `operator` and a goal lieutenant may send.** Reasons:

1. Attribution: the filename embeds the sender and `read` shows
   `from` — if any peer could write, neither field is evidence.
2. No sideways traffic (bi#144): peers never message peers. A peer
   that needs another owner's attention sends a directed handoff
   note through its lieutenant/operator, who re-sends via inbox.
   Sideways inbox writes bypass the dispatcher's ordering.
3. The lieutenant is already the trusted dispatcher+merger for its
   directory (`lieutenant.md`); inbox send is the dispatch half of
   that role. The operator is the root of direction.

Enforcement is at send time: `--as <sender>` must equal the `from`
header, and `<sender>` must be `operator` or appear in the
`--lieutenant <owner>` set passed for the goal directories the
sender lieutenants. Anything else is refused loud
(`INBOX REFUSED ... (only operator or a lieutenant may send)`),
exit 1 — nothing is written.

## 4. Live vs dead owners

Delivery is gated on the same liveness rule the dispatcher uses
(`cli.ts` lease filter): an owner is **live** iff the hub holds an
issue with `status = "Doing"`, `holder == <owner>`, and a parseable
`lease` in the future (`Date.parse(lease) > now`). Missing,
unparseable, expired, anonymous (bare `move` without `--as`), or
non-`Doing` claims all read as **dead** — reclaim, never jam (same
rule as `cli.ts`: "an unparseable lease reads as expired").

`--now <RFC3339-Z>` pins the clock for hermetic fixtures; default is
`Date.now()`.

## 5. Delivery: land vs re-queue loud

- **Live owner:** the message lands atomically in
  `.bais/inbox/<to>/`. Stdout: `INBOX DELIVERED <relpath>`, exit 0.
- **Dead owner:** the message MUST NOT land in the dead owner's
  queue (nobody will ever read it — that is how inboxes rot). It is
  rerouted to `.bais/inbox/_requeue/<to>/` preserving filename and
  content, for operator triage at the next sweep or teardown
  (bi#141 drains-or-requeues). Stdout names the reroute and the
  reason, loud: `INBOX REQUEUED <relpath> (owner <to> has no live
  claim; re-queued for operator triage)`, exit 0. Accepted but
  rerouted — loud, never silent.

## 6. Read-and-acknowledge semantics

- `read --owner <o>`: lists that queue's messages in filename
  (priority) order: one `INBOX MESSAGE <id> from=<f>
  priority=<NN> created_at=<ts>` line plus the body per message.
  **Reading never removes.** Only `<o>` or `operator` may read
  `<o>`'s queue (else `INBOX REFUSED ...`, exit 1).
- `ack --owner <o> <id>`: removes exactly that message file
  (`INBOX ACKED <id>`, exit 0). Acking an id with no file is
  `INBOX NO SUCH MESSAGE <id>`, exit 1 — ack is observable:
  `read` after `ack` no longer shows the id, and a second `ack`
  fails loud. Only `<o>` or `operator` may ack; `_requeue/` ids
  may be acked only by `operator`.
- Teardown (bi#141) closes over this: a queue is drained when
  `read` is empty; anything left is re-queued to Open issues,
  never silently dropped.

## 7. How handoff --validate treats inbox drops

One validator per surface, loud refusal across the boundary:

- `handoff-validate.mjs` accepts only `*.handoff`. An inbox drop
  (`.msg`) fails its filename rule — `bad filename ... (expected
  NN_..._from_<sender>.handoff)` — exit 1. Inbox files are never
  silently accepted as handoffs.
- `inbox.mjs validate` accepts only `*.msg` and symmetrically
  refuses `*.handoff` with repair guidance pointing at
  `handoff-validate.mjs`.
- Malformed inbox files are rejected with repair guidance mirroring
  `bais check`: `INBOX INVALID <file> (N errors)` + one
  `error\t<line>\t<message>` per problem + an `expected:` format
  block. Exit 0 + `INBOX VALID\t<file>` when clean.

## 8. Fixture gate (acceptance for bi#149)

In `../scripts/fixtures/inbox/`, run from `bais/`:

```bash
node scripts/fixtures/inbox/check.mjs --all
# → 9/9 assertions green across 6 checks, exit 0: live-owner send lands and reads back;
#   ack removes (second ack fails loud); dead-owner send re-queues loud;
#   handoff-validate refuses the .msg drop; inbox-validate refuses the
#   .handoff drop; bad-priority .msg fails with line-numbered repair guidance.
```

Plus: `baml check --project bais` stays green (no `.baml` touched).

## 9. Red-check (bi#57)

Recorded in `../scripts/inbox.mjs` header comments: the liveness
gate hunk was removed (dead owners treated as live), then the
fixture run was repeated over untouched fixtures — the dead-owner
drop landed silently in the dead queue and `--all` went red with
`expected INBOX REQUEUED for <dead-owner>, got INBOX DELIVERED`
(wrong outcome — the rot path the gate exists to prevent); with the
hunk restored all 9 assertions return to their §8 outcomes. A gate that
cannot go red on a dead-owner drop is camouflage, not coverage.
