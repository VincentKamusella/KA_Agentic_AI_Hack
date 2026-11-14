"""Shared PostgreSQL test setup."""
from django.test import TransactionTestCase

from backend.persistence.store import ResearchStore


class StoreCase(TransactionTestCase):
    def setUp(self):
        self.store = ResearchStore()
