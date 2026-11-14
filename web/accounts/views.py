"""Landing page, email-and-password account pages, and per-account JSON APIs."""
import json

from django.contrib.auth import login, logout
from django.contrib.auth import views as auth_views
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from web.accounts import services
from web.accounts.forms import SignInForm, SignUpForm
from web.accounts.models import Preferences

AREA_TYPES = {'radius', 'countries', 'continents', 'world', 'text'}


def account(request):
    """The signed-in user, or None."""
    return request.user if request.user.is_authenticated else None


def sign_in_required():
    return JsonResponse({'error': 'Sign in to continue.'}, status=401)


@require_GET
def landing(request):
    if account(request):
        return redirect('workspace')
    return render(request, 'landing.html')


def _next_url(request):
    target = request.POST.get('next') or request.GET.get('next') or ''
    safe = url_has_allowed_host_and_scheme(target, allowed_hosts={request.get_host()}, require_https=request.is_secure())
    return target if safe else ''


@require_http_methods(['GET', 'POST'])
def sign_up(request):
    if account(request):
        return redirect('workspace')
    form = SignUpForm(request.POST or None)
    if request.method == 'POST' and form.is_valid():
        login(request, form.save(), backend='django.contrib.auth.backends.ModelBackend')
        return redirect('workspace')
    return render(request, 'accounts/sign_up.html', {'form': form}, status=400 if form.errors else 200)


@require_http_methods(['GET', 'POST'])
def sign_in(request):
    if account(request):
        return redirect(_next_url(request) or 'workspace')
    form = SignInForm(request, request.POST or None)
    if request.method == 'POST' and form.is_valid():
        login(request, form.user)
        return redirect(_next_url(request) or 'workspace')
    return render(request, 'accounts/sign_in.html', {'form': form, 'next': _next_url(request)},
                  status=400 if form.errors else 200)


@require_POST
def sign_out(request):
    logout(request)
    return redirect('landing')


class ForgotPassword(auth_views.PasswordResetView):
    template_name = 'accounts/forgot_password.html'
    email_template_name = 'accounts/reset_email.txt'
    subject_template_name = 'accounts/reset_subject.txt'
    success_url = reverse_lazy('forgot-password-sent')


class ForgotPasswordSent(auth_views.PasswordResetDoneView):
    template_name = 'accounts/forgot_password_sent.html'


class ResetPassword(auth_views.PasswordResetConfirmView):
    template_name = 'accounts/reset_password.html'
    success_url = reverse_lazy('reset-password-done')


class ResetPasswordDone(auth_views.PasswordResetCompleteView):
    template_name = 'accounts/reset_password_done.html'


def _store():
    from backend.persistence.store import ResearchStore
    return ResearchStore()


@require_GET
def history(request):
    user = account(request)
    if not user:
        return sign_in_required()
    return JsonResponse({'searches': services.history(user, _store())})


@require_GET
def known_suppliers(request):
    user = account(request)
    if not user:
        return sign_in_required()
    return JsonResponse({'suppliers': services.known_suppliers(user, _store())})


def _preferences_json(preferences):
    return {'quantity_unit': preferences.quantity_unit, 'delivery_area': preferences.delivery_area,
            'other_requirements': preferences.other_requirements}


@require_http_methods(['GET', 'PUT'])
def preferences(request):
    user = account(request)
    if not user:
        return sign_in_required()
    saved, _ = Preferences.objects.get_or_create(user=user)
    if request.method == 'GET':
        return JsonResponse(_preferences_json(saved))
    if len(request.body) > 100_000:
        return JsonResponse({'error': 'Request is too large.'}, status=413)
    try:
        data = json.loads(request.body)
        unit, area, other = data['quantity_unit'], data['delivery_area'], data['other_requirements']
        valid = (isinstance(unit, str) and len(unit.strip()) <= 40
                 and isinstance(other, str) and len(other) <= 4000
                 and (area is None or (isinstance(area, dict) and area.get('type') in AREA_TYPES)))
    except (ValueError, KeyError, TypeError):
        valid = False
    if not valid:
        return JsonResponse({'error': 'These preferences could not be saved. Check the unit, destination and text length.'}, status=400)
    saved.quantity_unit, saved.delivery_area, saved.other_requirements = unit.strip(), area, other.strip()
    saved.save()
    return JsonResponse(_preferences_json(saved))
