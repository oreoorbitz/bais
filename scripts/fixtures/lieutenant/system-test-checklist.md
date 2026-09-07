# System-test ownership checklist — goals/inventory-mvp
# Lieutenant: lieut-145. Every box must be ticked; owner and covers must
# match plan-agreed-ok.events. Checked by check.mjs --all.

owner: lieut-145
covers: ingest,query

- [x] every plan component has a lieutenant-signed integration ref (ingest: handoff-001, query: handoff-002)
- [x] system test runs the full goal procedure, not per-component suites alone (no orphan integration)
- [x] system-test owner is the lieutenant (lieut-145), recorded on the system-test line
- [x] covers lists every plan component (ingest, query) and the result is pass
