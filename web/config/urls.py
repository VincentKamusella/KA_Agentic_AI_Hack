"""Product research, evaluation, and infrastructure routes."""
from django.contrib import admin
from django.http import JsonResponse
from django.urls import path
from django.views.decorators.http import require_GET
from web import views
from web.accounts import views as account_views


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("", account_views.landing, name="landing"),
    path("app/", views.workspace, name="workspace"),
    path("health/", health, name="health"),
    path("signup/", account_views.sign_up, name="sign-up"),
    path("signin/", account_views.sign_in, name="sign-in"),
    path("signout/", account_views.sign_out, name="sign-out"),
    path("password/forgot/", account_views.ForgotPassword.as_view(), name="forgot-password"),
    path("password/forgot/sent/", account_views.ForgotPasswordSent.as_view(), name="forgot-password-sent"),
    path("password/reset/<uidb64>/<token>/", account_views.ResetPassword.as_view(), name="password_reset_confirm"),
    path("password/reset/done/", account_views.ResetPasswordDone.as_view(), name="reset-password-done"),
    path("api/research/", views.start_research, name="start-research"),
    path("api/research/<str:job_id>/", views.research_status, name="research-status"),
    path("api/suggest-criteria/", views.suggest_criteria, name="suggest-criteria"),
    path("api/history/", account_views.history, name="history"),
    path("api/suppliers/", account_views.known_suppliers, name="known-suppliers"),
    path("api/preferences/", account_views.preferences, name="preferences"),
    path("admin/", admin.site.urls),
]
