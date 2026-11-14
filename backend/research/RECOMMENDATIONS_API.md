# Recommendation stage

New research and re-evaluation jobs automatically generate a final recommendation report after grading. The existing `POST /api/research/` request is unchanged. Poll `GET /api/research/{job_id}/` as before; `result.phase` now includes `recommendation` before `complete`.

Read `result.recommendation_report`:

- `summary`: the agent's contact recommendation and trade-offs.
- `no_eligible_suppliers`: computed from the original grades, not the agent.
- `candidate_supplier_ids`: the pool considered by the agent.
- `recommendations`: all evidence-backed, non-ineligible candidates (up to the 100-supplier research budget), ordered by eligibility, preference score, evidence coverage, and product fit. Each contains `supplier_id`, `qualification`, `reasons` (`text` and supplier-local `evidence_ids`), `tradeoffs`, `verification_questions` (`criterion_id` and `question`), and `email_draft` (`subject` and `body`). Resolve evidence IDs against the matching entry in `result.suppliers` for source links.

`qualification` is computed by the server: `meets_documented_requirements` for eligible suppliers, otherwise `outreach_only`. Ineligible suppliers and suppliers without evidence or an assessment cannot be recommended. An outreach recommendation does not change the original grades or `recommended_supplier_ids`, which remains the deterministic eligible-only shortlist.

The agent sees at most 12 candidates, sorted by eligibility, preference score, coverage, and supplier ID; each includes up to five source excerpts. An empty recommendation list is valid when evidence is insufficient. The structured checks reject unknown/duplicate supplier IDs, invalid evidence references, and missing or invented verification criterion IDs. They do not independently prove the truth of generated prose.

Email drafts include the original purchase details, all criteria, every unresolved criterion's confirmation question, and standard quotation questions. They are plain text, have no recipient address, and are never sent. Render generated text as text, not trusted HTML.

If generation fails, the job still completes with its research and grades. The report is `null` and `result.issues` includes `stage: "recommendation"`, `code: "recommendation_unavailable"`. Older saved results may omit the report entirely. To regenerate using saved sources, submit the original research job's ID as `discovery_job_id` with the unchanged purchase brief; this reruns grading and recommendations without crawling again.

`GEMINI_RECOMMENDATION_MODEL` defaults to `gemini-4-hydrogen`. The stage uses one structured Interactions request with `store: false`, plus at most one retry for HTTP 429/503. No database migration or new endpoint is required.
