"""HTTP requests enqueue backend work and retrieve saved results."""
import json

from django.core.exceptions import RequestDataTooBig
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from backend.research.requests import StageRequest


def request_too_large(request):
    try:
        return len(request.body) > 16_000_000
    except RequestDataTooBig:
        return True


@ensure_csrf_cookie
@require_GET
def index(request):
    return render(request, "index.html")


@require_POST
def start_research(request):
    from backend.research.jobs import start_job
    from backend.persistence.store import ResearchStore
    if request_too_large(request):
        return JsonResponse({"error": "Request is too large."}, status=413)
    try:
        payload = StageRequest.model_validate(json.loads(request.body))
        job_id = start_job(ResearchStore(), payload)
        return JsonResponse({"job_id": job_id, "status": "queued"}, status=202)
    except ValueError:
        # Validation errors can contain submitted data; return only our stable message.
        return JsonResponse({"error": "Invalid request. Evaluation requires a completed discovery job with suppliers; submit its discovery_job_id, not evidence."}, status=400)
    except RuntimeError as exc:
        return JsonResponse({"error": str(exc)}, status=429)


@require_GET
def research_status(request, job_id):
    from backend.persistence.store import ResearchStore
    result = ResearchStore().get(job_id)
    response = JsonResponse(result if result else {"error": "Research job not found."}, status=200 if result else 404)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response
