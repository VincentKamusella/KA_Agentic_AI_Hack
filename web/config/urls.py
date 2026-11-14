"""Product research, evaluation, and infrastructure routes."""
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path
from django.views.decorators.http import require_GET
from web import views


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("", views.index, name="index"),
    path("health/", health, name="health"),
    path("api/discover/", views.stage, {"stage_name": "discover"}, name="discover"),
    path("api/evaluate/", views.stage, {"stage_name": "evaluate"}, name="evaluate"),
    path("api/research/", views.start_research, name="start-research"),
    path("api/evaluate-jobs/", views.start_research, {"stage_name": "evaluate"}, name="start-evaluation"),
    path("api/research/<str:job_id>/", views.research_status, name="research-status"),
    path("admin/", admin.site.urls),
]
