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
    path("api/research/", views.start_research, name="start-research"),
    path("api/research/<str:job_id>/", views.research_status, name="research-status"),
    path("admin/", admin.site.urls),
]
