"""Infrastructure routes only; product routes will be added later."""
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
    path("admin/", admin.site.urls),
]
