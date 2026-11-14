"""HTTP requests enqueue backend work and retrieve saved results."""
import json
from pydantic import ValidationError

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


STREAM_TYPE = "application/x-ndjson"


def stage_error(exc):
    """Map a stage failure to (HTTP status, safe browser message)."""
    if isinstance(exc, GeminiError):
        return 502, str(exc)
    if isinstance(exc, TimeoutError):
        return 504, "This stage timed out. Reduce the number of criteria and retry."
    logger.error("QuotePilot stage failed", exc_info=exc)
    return 500, "Analysis failed unexpectedly. Please retry; server logs contain the details."


def stream_stage(run):
    """Run a stage in a worker thread and stream its real progress as NDJSON.

    Lines are {"type": "step"|"supplier", ...} events, then exactly one
    {"type": "result", "data": ...} or {"type": "error", "status", "error"}.
    """
    events = queue.Queue()
    started = time.monotonic()

    def progress(event):
        events.put({**event, "elapsed": round(time.monotonic() - started, 2)})

    def worker():
        try:
            events.put({"type": "result", "data": run(progress).model_dump(mode="json")})
        except Exception as exc:  # Reported to the browser as a terminal event.
            status, message = stage_error(exc)
            events.put({"type": "error", "status": status, "error": message})

    threading.Thread(target=worker, daemon=True).start()

    def lines():
        while True:
            event = events.get()
            yield json.dumps(event) + "\n"
            if event["type"] in ("result", "error"):
                return

    response = StreamingHttpResponse(lines(), content_type=STREAM_TYPE)
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response


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
    result = ResearchStore().get(job_id)
    response = JsonResponse(result if result else {"error": "Research job not found."}, status=200 if result else 404)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response
