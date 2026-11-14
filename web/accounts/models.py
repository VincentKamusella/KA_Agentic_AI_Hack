"""What belongs to one signed-in account: its searches and its brief defaults."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class SearchRecord(models.Model):
    """Links a research job to the account that started it.

    Research jobs themselves stay in the backend's store; this row is what
    makes a job visible to, and only to, its owner.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='searches')
    job_token = models.CharField(max_length=64, unique=True)
    product = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=['user', '-created_at'], name='accounts_user_searches')]
        ordering = ['-created_at']


class Preferences(models.Model):
    """Defaults that prefill a new brief. Empty values mean "no default"."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='preferences')
    quantity_unit = models.CharField(max_length=40, blank=True)
    # The map selection as the browser stores it (radius, countries, …).
    delivery_area = models.JSONField(null=True, blank=True)
    other_requirements = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)
