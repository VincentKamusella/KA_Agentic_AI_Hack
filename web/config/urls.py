"""Infrastructure routes only; product routes will be added later."""
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path
from django.views.decorators.http import require_GET


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("", health, name="health"),
    path("admin/", admin.site.urls),
]
