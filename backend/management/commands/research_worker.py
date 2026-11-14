"""Django CLI entry point for the research worker service."""
import argparse

from django.core.management.base import BaseCommand

from backend.research.worker import run_worker


class Command(BaseCommand):
    help = 'Process queued research in a separate service. Run alongside the web server.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='Process at most one queued job, then exit.')
        parser.add_argument('--health-port', type=int, default=0, help='Optional private HTTP liveness port.')
        parser.add_argument('--execute', help=argparse.SUPPRESS)
        parser.add_argument('--lease', help=argparse.SUPPRESS)

    def handle(self, *args, **options):
        run_worker(once=options['once'], execute=options['execute'], lease=options['lease'],
                   health_port=options['health_port'], write=self.stdout.write)
