"""Create the shared test account. Refuses to run outside local development."""
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

EMAIL = 'test@quotepilot.local'
PASSWORD = 'quotepilot-test'


class Command(BaseCommand):
    help = 'Create or reset the local test account (only when DJANGO_DEBUG is true).'

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError('The test account has a publicly known password and is only created when DJANGO_DEBUG is true.')
        user, _ = get_user_model().objects.get_or_create(username=EMAIL, defaults={'email': EMAIL})
        user.email = EMAIL
        user.set_password(PASSWORD)
        user.save()
        self.stdout.write(f'Test account ready: {EMAIL} / {PASSWORD}')
