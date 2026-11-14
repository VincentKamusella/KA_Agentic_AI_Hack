"""Validated product endpoints and durable background research job access."""
import asyncio
import json
import logging

from asgiref.sync import async_to_sync
from django.core.exceptions import RequestDataTooBig
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from pydantic import Field, ValidationError, model_validator

from backend.contracts import Contract, DiscoveryOptions, Requirements, SupplierEvidence
from backend.discovery import GeminiDiscovery
from backend.evaluation import GeminiEvaluator
from backend.gemini import GeminiClient, GeminiError
from backend.pipeline import shortlist

logger = logging.getLogger(__name__)
STAGE_TIMEOUT_SECONDS = 180


def request_too_large(request):
    try:
        return len(request.body) > 16_000_000
    except RequestDataTooBig:
        return True


async def run_stage(awaitable):
    return await asyncio.wait_for(awaitable, timeout=STAGE_TIMEOUT_SECONDS)


class StageRequest(Contract):
    requirements: Requirements
    options: DiscoveryOptions = Field(default_factory=DiscoveryOptions)
    discovery_job_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    suppliers: list[SupplierEvidence] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def bounded_work(self):
        if not 1 <= len(self.requirements.criteria) <= 12:
            raise ValueError("Provide between 1 and 12 criteria.")
        if any(len(c.description) > 1000 for c in self.requirements.criteria):
            raise ValueError("Criterion descriptions must be at most 1,000 characters.")
        if any(c.weight > 100 for c in self.requirements.criteria):
            raise ValueError("Criterion weights must be at most 100.")
        if len(self.requirements.product) > 1000 or len(self.requirements.delivery_country) > 100:
            raise ValueError("Product or destination is too long.")
        if len({s.supplier_id for s in self.suppliers}) != len(self.suppliers):
            raise ValueError("Duplicate supplier IDs.")
        for s in self.suppliers:
            if len(s.evidence) > 20 or len({e.id for e in s.evidence}) != len(s.evidence):
                raise ValueError("At most 20 unique evidence excerpts per supplier.")
            if any(len(e.excerpt) > 6000 for e in s.evidence):
                raise ValueError("Evidence excerpts must be at most 6,000 characters.")
        return self


@ensure_csrf_cookie
@require_GET
def index(request):
    return render(request, "index.html")


@require_POST
def stage(request, stage_name):
    if request_too_large(request):
        return JsonResponse({"error": "Request is too large."}, status=413)
    try:
        payload = StageRequest.model_validate(json.loads(request.body))
        if stage_name == "discover":
            service = GeminiDiscovery(GeminiClient())
            options = payload.options
            result = async_to_sync(run_stage)(service.discover_suppliers(payload.requirements, options=options))
        else:
            if not payload.suppliers:
                return JsonResponse({"error": "Discover at least one supplier first."}, status=400)
            service = GeminiEvaluator(GeminiClient())
            suppliers = payload.suppliers
            evaluation = async_to_sync(run_stage)(service.evaluate_suppliers(payload.requirements, suppliers))
            result = shortlist(suppliers, evaluation)
        return JsonResponse(result.model_dump(mode="json"))
    except (ValueError, ValidationError):
        return JsonResponse({"error": "Invalid request. Check the product, quantity, criteria and evidence limits."}, status=400)
    except GeminiError as exc:
        return JsonResponse({"error": str(exc)}, status=502)
    except TimeoutError:
        return JsonResponse({"error": "This stage timed out. Reduce the number of criteria and retry."}, status=504)
    except Exception:
        logger.exception("QuotePilot stage failed")
        return JsonResponse({"error": "Analysis failed unexpectedly. Please retry; server logs contain the details."}, status=500)


@require_POST
def start_research(request, stage_name="discover"):
    from backend.jobs import start_job
    from backend.research import ResearchStore
    if request_too_large(request):
        return JsonResponse({"error": "Request is too large."}, status=413)
    try:
        payload = StageRequest.model_validate(json.loads(request.body))
        if stage_name == "evaluate" and not payload.suppliers:
            return JsonResponse({"error": "Discover at least one supplier first."}, status=400)
        job_id = start_job(ResearchStore(), payload, stage_name)
        return JsonResponse({"job_id": job_id, "status": "running"}, status=202)
    except (ValueError, ValidationError):
        return JsonResponse({"error": "Invalid research request. Check search and evidence limits."}, status=400)
    except GeminiError as exc:
        return JsonResponse({"error": str(exc)}, status=502)
    except RuntimeError as exc:
        return JsonResponse({"error": str(exc)}, status=429)


@require_GET
def research_status(request, job_id):
    from backend.research import ResearchStore
    result = ResearchStore().get(job_id)
    response = JsonResponse(result if result else {"error": "Research job not found."}, status=200 if result else 404)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response
