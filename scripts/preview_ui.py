"""Local UI preview with FICTIONAL data. Development only.

Runs the Django dev server on 127.0.0.1 with the research queue replaced by an
in-memory imitation, so the interface can be reviewed without a Gemini key,
PostgreSQL, or a worker. Accounts, history links and preferences are kept in
preview.sqlite3 in the project folder. Sign in with the test account:

    test@quotepilot.local / quotepilot-test

Password-reset emails are printed in this terminal. It is not routed, imported, or started by the deployed
application, which always runs real research.

    uv run python scripts/preview_ui.py [port]        # http://127.0.0.1:8001/

Every search "finds" the three fictional suppliers from
fixtures/example_pipeline.json and walks through the real phases
(interpreting, discovery, evaluation) in a few seconds. Results are invented:

- "Other requirements" is split at semicolons; a part containing "required",
  "must" or "need" becomes a must-have, anything else a nice-to-have.
- Setting a "Needed by" date leaves every supplier needing verification,
  which shows the empty-shortlist state.
- A product containing "#fail" makes interpretation fail.
- Research jobs are lost when the server restarts; History then shows only
  searches made since.
"""
import asyncio
import copy
import json
import os
import re
import secrets
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "scripts.preview_settings")
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "local-development-only-ui-preview")
# The base settings require a PostgreSQL URL; preview_settings swaps in SQLite.
os.environ.setdefault("DATABASE_URL", "postgresql://preview:preview@127.0.0.1:5432/preview")

import django  # noqa: E402

django.setup()

from django.core.management import call_command  # noqa: E402
from django.core.management.base import BaseCommand  # noqa: E402

import backend.persistence.store as store_module  # noqa: E402
import backend.research.jobs as jobs_module  # noqa: E402
from backend.domain.contracts import (  # noqa: E402
    CriterionAssessment, Criterion, DecisionMetrics, EvaluationResult, EvidenceDecision, Requirements,
    SuggestCriteriaResponse, SupplierDecisionMetrics, SupplierEvidence)
from backend.evaluation.service import aggregate  # noqa: E402
from backend.integrations.gemini import GeminiError  # noqa: E402
from backend.research.brief import interpret_requirements  # noqa: E402
from backend.research.pipeline import shortlist  # noqa: E402
from backend.tests.support import demo_fixture  # noqa: E402

JOBS = {}
STEP = 1.6  # seconds between checkpoints
PURCHASE_FIELDS = ("product", "quantity", "quantity_unit", "delivery_country", "needed_by", "other_requirements")
# Result per supplier for the criteria the backend always creates.
SAVED = {
    "alpha": {"product": "pass", "quantity": "pass", "destination": "pass", "deadline": "unknown", "extra": "pass"},
    "beta": {"product": "fail", "quantity": "unknown", "destination": "pass", "deadline": "unknown", "extra": "unknown"},
    "gamma": {"product": "unknown", "quantity": "unknown", "destination": "unknown", "deadline": "unknown", "extra": "unknown"},
}
EXPLANATIONS = {
    "pass": "Source evidence supports this criterion.",
    "fail": "Source evidence explicitly contradicts this criterion.",
    "unknown": "No sufficiently confident, explicit evidence. Confirm with the supplier.",
}


class PreviewInterpreter:
    """Stands in for Gemini: quotes the parts of the text between semicolons."""

    async def post(self, endpoint, payload):
        text = json.loads(payload["input"].split("Input: ", 1)[1])
        parts = [part.strip() for part in re.split(r"[;\n]", text) if part.strip()][:8]
        criteria = [{"description": part, "kind": "mandatory" if re.search(r"required|must|need", part, re.I) else "preference"}
                    for part in parts]
        return {"status": "completed", "steps": [{"type": "model_output", "content": [
            {"type": "text", "text": json.dumps({"criteria": criteria})}]}]}


class PreviewStore:
    def get(self, job_id):
        return copy.deepcopy(JOBS.get(job_id))


def start_job(store, payload, stage="research"):
    if payload.discovery_job_id:
        source = JOBS.get(payload.discovery_job_id)
        if not source or source["status"] != "completed" or not (source["result"] or {}).get("suppliers"):
            raise ValueError("A completed discovery job is required.")
        original = Requirements.model_validate(source["request"]["requirements"])
        if any(getattr(original, key) != getattr(payload.requirements, key) for key in PURCHASE_FIELDS):
            raise ValueError("Changed purchase briefs require fresh research.")
    job_id = secrets.token_hex(32)
    JOBS[job_id] = {"job_id": job_id, "status": "queued", "result": None, "error": None,
                    "request": payload.model_dump(mode="json") | {"stage": stage}}
    threading.Thread(target=run_job, args=(job_id, payload), daemon=True).start()
    return job_id


def run_job(job_id, payload):
    job = JOBS[job_id]

    def checkpoint(result, phase, requirements):
        time.sleep(STEP)
        job["status"] = "running"
        job["result"] = {**result, "phase": phase,
                         "requirements": requirements.model_dump(mode="json") if requirements else None}

    try:
        checkpoint({}, "interpreting", None)
        if "#fail" in payload.requirements.product:
            raise GeminiError("Could not interpret your requirements reliably. Rephrase them and retry.")
        requirements = asyncio.run(interpret_requirements(payload.requirements, PreviewInterpreter()))
        checkpoint({}, "interpreting", requirements)

        fixture = demo_fixture()["response"]["suppliers"]
        fit = {"alpha": ("pass", 0.93, 88, "from EUR 0.42 per piece"), "beta": ("pass", 0.71, 61, None),
               "gamma": ("unknown", 0.55, 30, None)}
        suppliers = [SupplierEvidence.model_validate({
            **supplier, "crawl_status": "partial", "discovered_by": ["preview search"],
            "fit_rank": index, "fit_result": fit[supplier["supplier_id"]][0],
            "fit_confidence": fit[supplier["supplier_id"]][1], "fit_score": fit[supplier["supplier_id"]][2],
            "price": fit[supplier["supplier_id"]][3],
            "evidence": [{**evidence, "kind": "page", "title": f"About {supplier['name']}"} for evidence in supplier["evidence"]],
        }) for index, supplier in enumerate(fixture, 1)]
        coverage = {"queries": [], "candidates_found": 0, "researched": 0, "pending": 0, "source_pages": 0,
                    "directory_urls": [], "stop_reason": "searching", "exhaustive": False}
        dumped = [supplier.model_dump(mode="json") for supplier in suppliers]
        if not payload.discovery_job_id:
            for index, query in enumerate(["manufacturers", "distributors"]):
                coverage["queries"].append({
                    "query": f"{requirements.product} {query}", "country": requirements.delivery_country,
                    "language": "English", "source_type": query, "actual_queries": [f"{requirements.product} {query}"],
                    "candidates_found": 2, "new_suppliers": 2 - index, "duplicate_suppliers": index,
                    "unresolved_citations": 0, "cached": False, "failed": False})
                found = 2 + index
                coverage.update(candidates_found=found, researched=found, source_pages=found)
                checkpoint({"suppliers": dumped[:found], "issues": [], "coverage": copy.deepcopy(coverage),
                            "deferred_suppliers": []}, "discovery", requirements)
        else:
            coverage = copy.deepcopy(JOBS[payload.discovery_job_id]["result"]["coverage"])
        coverage["stop_reason"] = "query_budget"

        evaluation = EvaluationResult()

        def combined():
            return {**shortlist(suppliers, evaluation, []).model_dump(mode="json"),
                    "requirements": requirements.model_dump(mode="json"), "coverage": coverage, "deferred_suppliers": []}

        supplier_metrics = []

        def metrics():
            answers = [d for a in evaluation.assessments for c in a.criteria for d in c.decisions]
            return DecisionMetrics(
                model="gemini-decision-1", confidence_threshold=0.85, calls=len(supplier_metrics),
                questions=len(answers), counted=sum(d.counted for d in answers),
                pass_count=sum(d.counted and d.choice == "pass" for d in answers),
                fail_count=sum(d.counted and d.choice == "fail" for d in answers),
                abstained=sum(d.choice == "unknown" for d in answers),
                below_threshold=sum(not d.counted and d.choice != "unknown" for d in answers),
                elapsed_seconds=round(STEP * len(supplier_metrics), 2),
                evaluation_instructions="Preview only: these answers are invented, not model output.",
                suppliers=supplier_metrics)

        evaluation.metrics = metrics()
        checkpoint(combined(), "evaluation", requirements)
        for supplier in suppliers:
            criteria = []
            for criterion in requirements.criteria:
                key = "extra" if criterion.id.startswith("extra_") else criterion.id
                result = SAVED[supplier.supplier_id].get(key, "unknown")
                criteria.append(CriterionAssessment(
                    criterion_id=criterion.id, result=result,
                    score=(100 if result == "pass" else 0) if criterion.kind == "preference" and result != "unknown" else None,
                    evidence_ids=[supplier.evidence[0].id] if result != "unknown" else [],
                    explanation=EXPLANATIONS[result],
                    decisions=[EvidenceDecision(
                        evidence_id=supplier.evidence[0].id, choice=result if result != "unknown" else (
                            "pass" if criterion.id == "quantity" else "unknown"),
                        confidence=0.93 if result != "unknown" else 0.62, counted=result != "unknown")]))
            evaluation.assessments.append(aggregate(requirements, supplier.supplier_id, criteria))
            results = [c.result for c in criteria]
            supplier_metrics.append(SupplierDecisionMetrics(
                supplier_id=supplier.supplier_id, status="done", questions=len(criteria), calls=1,
                elapsed_seconds=STEP, pass_count=results.count("pass"), fail_count=results.count("fail"),
                unknown_count=results.count("unknown"),
                below_threshold_count=sum(c.id == "quantity" and r == "unknown" for c, r in zip(requirements.criteria, results))))
            evaluation.metrics = metrics()
            checkpoint(combined(), "evaluation", requirements)
        job["result"] = {**combined(), "phase": "complete"}
        job["status"] = "completed"
    except GeminiError as exc:
        job["status"], job["error"] = "failed", str(exc)
    except Exception as exc:  # Surface preview bugs in the UI instead of hanging.
        job["status"], job["error"] = "failed", f"Preview error: {exc}"


class PreviewSuggester:
    def __init__(self, client):
        pass

    async def suggest_criteria(self, payload):
        return SuggestCriteriaResponse(criteria=[
            Criterion(id="iso-9001", description="The supplier holds ISO 9001 certification.", kind="mandatory"),
            Criterion(id="samples", description="The supplier offers samples before an order.", kind="preference"),
        ])


import web.views as views_module  # noqa: E402

views_module.GeminiClient = lambda: None
views_module.GeminiCriteriaSuggester = PreviewSuggester
store_module.ResearchStore = PreviewStore
jobs_module.start_job = start_job

if __name__ == "__main__":
    port = sys.argv[1] if len(sys.argv) > 1 else "8001"
    call_command("migrate", run_syncdb=True, verbosity=0)
    call_command("create_test_account")
    print("QuotePilot UI preview: FICTIONAL suppliers, no Gemini calls.")
    # The autoreloader restarts this script, so the patches above are reapplied
    # and template or static edits show up without a manual restart.
    call_command("runserver", f"127.0.0.1:{port}")
