"""HTTP requests enqueue backend work and retrieve saved results."""
import asyncio
import json
from pydantic import ValidationError

from asgiref.sync import async_to_sync
from django.core.exceptions import RequestDataTooBig
from django.http import JsonResponse
from django.contrib.auth.views import redirect_to_login
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from pydantic import ValidationError

from backend.criteria import GeminiCriteriaSuggester
from backend.domain.contracts import SuggestCriteriaRequest
from backend.integrations.gemini import GeminiClient, GeminiError
from backend.research.requests import StageRequest
from web.accounts import services as accounts
from web.accounts.views import account, sign_in_required


def request_too_large(request):
    try:
        return len(request.body) > 16_000_000
    except RequestDataTooBig:
        return True


@ensure_csrf_cookie
@require_GET
def workspace(request):
    if not account(request):
        return redirect_to_login(request.get_full_path())
    return render(request, "index.html")


@require_POST
def suggest_criteria(request):
    if not account(request):
        return sign_in_required()
    if request_too_large(request) or len(request.body) > 50_000:
        return JsonResponse({"error": "Request is too large."}, status=413)
    try:
        payload = SuggestCriteriaRequest.model_validate(json.loads(request.body))
        service = GeminiCriteriaSuggester(GeminiClient())
        result = async_to_sync(asyncio.wait_for)(service.suggest_criteria(payload), timeout=60)
    except (ValueError, ValidationError):
        return JsonResponse({"error": "Enter a product description before generating criteria."}, status=400)
    except GeminiError as exc:
        return JsonResponse({"error": str(exc)}, status=502)
    except TimeoutError:
        return JsonResponse({"error": "Criteria suggestion timed out. Please retry."}, status=504)
    return JsonResponse(result.model_dump(mode="json"))


@require_POST
def start_research(request):
    from backend.research.jobs import start_job
    from backend.persistence.store import ResearchStore
    user = account(request)
    if not user:
        return sign_in_required()
    if request_too_large(request):
        return JsonResponse({"error": "Request is too large."}, status=413)
    try:
        payload = StageRequest.model_validate(json.loads(request.body))
        # Saved evidence may only be reused by the account that collected it.
        if payload.discovery_job_id and not accounts.owns(user, payload.discovery_job_id):
            raise ValueError("Unknown discovery job.")
        stage = "evaluate" if payload.discovery_job_id else "research"
        job_id = start_job(ResearchStore(), payload, stage=stage)
        accounts.record_search(user, job_id, payload.requirements.product)
        return JsonResponse({"job_id": job_id, "status": "queued"}, status=202)
    except ValidationError as exc:
        return JsonResponse({"error": "Check your purchase details.", "fields": [
            {"path": '.'.join(str(part) for part in error['loc']), "message": error['msg']}
            for error in exc.errors(include_input=False, include_context=False, include_url=False)
        ]}, status=400)
    except ValueError:
        # Validation errors can contain submitted data; return only our stable message.
        return JsonResponse({"error": "Invalid request. Evaluation requires a completed discovery job with suppliers; submit its discovery_job_id, not evidence."}, status=400)
    except RuntimeError as exc:
        return JsonResponse({"error": str(exc)}, status=429)


@require_GET
def research_status(request, job_id):
    from backend.persistence.store import ResearchStore
    user = account(request)
    if not user:
        return sign_in_required()
    # Jobs of other accounts look exactly like jobs that do not exist.
    result = ResearchStore().get(job_id) if accounts.owns(user, job_id) else None
    response = JsonResponse(result if result else {"error": "Research job not found."}, status=200 if result else 404)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response
