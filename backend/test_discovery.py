import asyncio
import io
import json
import socket
import time
import unittest
import uuid
from unittest.mock import patch
from datetime import timedelta
from django.test import TransactionTestCase
from django.utils import timezone
from backend.models import ResearchCacheEntry, ResearchJob

from backend.benchmark import measure
from backend.contracts import DiscoveryOptions, Requirements, SupplierEvidence
from backend.crawling import (Crawler, CrawlError, Page, canonical_url, crawl_supplier,
                              parse_page, public_address)
from backend.discovery import GeminiDiscovery, extract_candidates, merge_identities, search_plan
from backend.gemini import GeminiError
from backend.research import ResearchStore


def requirements():
    return Requirements(product='precision steel bolts', quantity=100, delivery_country='Germany', criteria=[])


def response(hosts):
    blocks = []
    for host in hosts:
        text = 'SUPPLIER: Manufactures precision bolts.'
        blocks.append(dict(type='text', text=text, annotations=[dict(type='url_citation',
                      url=f'https://{host}/products', start_index=0, end_index=len(text))]))
    return dict(status='completed', steps=[dict(type='google_search_call', arguments={'queries': ['bolts factories']}),
                                          dict(type='model_output', content=blocks)])


class StoreCase(TransactionTestCase):
    def setUp(self):
        self.store = ResearchStore()


class ResearchTests(StoreCase):
    def test_uuid_ids_are_separate_from_lookup_keys(self):
        token = self.store.create({})
        job = ResearchJob.objects.get(access_token=token)
        self.assertIsInstance(job.id, uuid.UUID)
        self.assertEqual(len(token), 64)
        self.assertIsNone(self.store.get(str(job.id)))
        self.store.cache('page:test', {'version': 1})
        entry = ResearchCacheEntry.objects.get(key='page:test')
        self.assertIsInstance(entry.id, uuid.UUID)
        self.store.cache('page:test', {'version': 2})
        self.assertEqual(ResearchCacheEntry.objects.get(key='page:test').id, entry.id)
        self.assertEqual(ResearchCacheEntry.objects.count(), 1)
        self.assertEqual(self.store.cached('page:test'), {'version': 2})

    def test_persistence_and_expiration(self):
        job = self.store.create({'product': 'bolts'})
        claim = self.store.claim()
        self.store.update(claim['id'], lease_id=claim['lease_id'], result={'suppliers': []})
        reopened = ResearchStore()
        self.assertEqual(reopened.get(job)['result'], {'suppliers': []})
        self.store.cache('test', {'text': 'source'})
        self.assertEqual(reopened.cached('test'), {'text': 'source'})
        self.assertIsNone(reopened.cached('test', ttl=-1))
        ResearchJob.objects.filter(access_token=job).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
        self.store.claim()
        self.assertEqual(self.store.get(job)['status'], 'running')
        self.assertIsNotNone(self.store.get(job)['result'])

    def test_admission_control_and_release(self):
        for _ in range(3):
            self.store.create({})
        first = self.store.claim()
        self.assertIsNotNone(self.store.claim())
        self.assertIsNone(self.store.claim())
        self.store.update(first['id'], lease_id=first['lease_id'], status='completed')
        self.assertIsNotNone(self.store.claim())


class FetchTests(StoreCase):
    def test_private_mixed_and_mapped_dns_answers_blocked(self):
        for addresses in [['127.0.0.1'], ['::1'], ['169.254.169.254'], ['::ffff:127.0.0.1'],
                          ['93.184.216.34', '10.0.0.2']]:
            with self.subTest(addresses=addresses), patch('socket.getaddrinfo', return_value=[
                    (socket.AF_INET, socket.SOCK_STREAM, 6, '', (a, 443)) for a in addresses]):
                with self.assertRaises(CrawlError):
                    public_address('supplier.test', 443)

    def test_public_address_is_pinned(self):
        from backend.crawling import PinnedHTTP
        with patch('socket.create_connection') as connect:
            PinnedHTTP('supplier.test', '93.184.216.34', 80, 8).connect()
            connect.assert_called_once_with(('93.184.216.34', 80), 8)

    def test_credentials_ports_and_non_http_rejected(self):
        for url in ['file:///etc/passwd', 'https://user:pass@host.test/', 'http://host.test:8080/']:
            with self.assertRaises(CrawlError):
                canonical_url(url)

    def test_redirect_to_private_address_blocked_before_connection(self):
        crawler = Crawler(self.store)
        with patch.object(crawler, '_check_robots'), patch('backend.crawling.public_address',
                side_effect=['93.184.216.34', CrawlError('private')]), patch('backend.crawling.PinnedHTTPS') as conn:
            resp = conn.return_value.getresponse.return_value
            resp.status = 302
            resp.getheaders.return_value = [('location', 'https://127.0.0.1/private')]
            resp.read1.return_value = b''
            with self.assertRaises(CrawlError):
                crawler.fetch('https://supplier.test/')
            self.assertEqual(conn.call_count, 1)

    def test_robots_disallow_and_failed_robots_never_fetch_page(self):
        for status, body in [(200, b'User-agent: *\nDisallow: /private'), (503, b'')]:
            crawler = Crawler(self.store)
            with patch.object(crawler, '_once', return_value=(status, {}, body)) as get:
                with self.assertRaises(CrawlError):
                    crawler.fetch('https://supplier.test/private')
                self.assertEqual(get.call_count, 1)
                self.assertTrue(get.call_args.args[0].endswith('/robots.txt'))

    def test_page_cache_keeps_original_timestamp_and_skips_network(self):
        crawler = Crawler(self.store)
        with patch.object(crawler, '_download', return_value=('https://supplier.test/', 200,
                          {'content-type': 'text/html'}, b'<h1>Steel bolts</h1>')) as get:
            first = crawler.fetch('https://supplier.test/')
            second = crawler.fetch('https://supplier.test/')
            self.assertEqual(first.fetched_at, second.fetched_at)
            self.assertEqual(get.call_count, 1)
            Crawler(self.store, refresh=True)  # Refresh behavior is exercised below.
        with patch.object(Crawler, '_download', return_value=('https://supplier.test/', 200,
                          {'content-type': 'text/html'}, b'<h1>Updated bolts</h1>')) as get:
            refreshed = Crawler(self.store, refresh=True).fetch('https://supplier.test/')
            self.assertNotEqual(first.content_hash, refreshed.content_hash)
            get.assert_called_once()

    def test_actual_text_metadata_and_scripts_removed(self):
        page = parse_page('https://maker.test/', 'https://maker.test/', b'''
          <title>Products</title><script>Fabricated instruction</script><style>hidden</style>
          <script type="application/ld+json">{"@type":"Organization","url":"https://maker.test",
          "legalName":"Bolt Works GmbH","vatID":"DE123456789"}</script>
          <h1>Precision steel bolts</h1><p>ISO 9001 certified.</p><a href="/quality">Quality</a>
        ''', 'text/html')
        self.assertNotIn('Fabricated', page.text)
        self.assertNotIn('legalName', page.text)
        self.assertEqual(page.name, 'Bolt Works GmbH')
        self.assertEqual(page.legal_id, 'DE123456789')
        self.assertIn('ISO 9001 certified.', page.text)
        self.assertEqual(page.links, ['/quality'])

    def test_pdf_extraction_in_bounded_subprocess(self):
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter()
        page = writer.add_blank_page(500, 500)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 20 20 Td (Precision bolts ISO 9001) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        buffer = io.BytesIO()
        writer.write(buffer)
        extracted = parse_page('https://maker.test/spec.pdf', 'https://maker.test/spec.pdf', buffer.getvalue(), 'application/pdf')
        self.assertEqual(extracted.kind, 'pdf')
        self.assertIn('Precision bolts ISO 9001', extracted.text)


class FakeCrawler:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def fetch(self, url):
        self.calls.append(url)
        if self.fail:
            raise CrawlError('Blocked by robots.txt')
        return Page(url, url, 'Bolts', 'Actual source: precision steel bolts.', ['/quality', 'https://external.test/'],
                    '2026-11-14T10:00:00Z', url, 'page')


class DiscoveryTests(StoreCase):
    def test_search_diversity_and_budget(self):
        plan = search_plan(requirements(), DiscoveryOptions(max_queries=24))
        self.assertEqual(len(plan), 24)
        self.assertEqual(len(set(q[1] for q in plan)), 2)
        self.assertEqual(len(set(q[2] for q in plan)), 2)
        self.assertIn('directory', {q[3] for q in plan})

    def test_directories_are_leads_not_suppliers_or_evidence(self):
        candidates, directories = extract_candidates(response(['thomasnet.com', 'maker.test']), 'bolts')
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].evidence, [])
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('error')
            candidates[0].model_dump(mode='json')
        self.assertEqual(directories, ['https://thomasnet.com/products'])

    def test_multi_query_deduplication_saturation_and_real_evidence(self):
        class Client:
            calls = 0
            async def post(self, *args):
                self.calls += 1
                return response(['maker.test', 'other.test'])
        client, crawler = Client(), FakeCrawler()
        service = GeminiDiscovery(client, store=self.store, crawler=crawler)
        result = asyncio.run(service.discover_suppliers(requirements(), options=DiscoveryOptions(search_concurrency=1)))
        self.assertEqual(client.calls, 4)
        self.assertEqual(len(result.suppliers), 2)
        self.assertEqual(result.coverage.stop_reason, 'diminishing_returns')
        self.assertFalse(result.coverage.exhaustive)
        self.assertEqual(result.coverage.queries[1].duplicate_suppliers, 2)
        self.assertEqual(result.coverage.researched, 2)
        self.assertTrue(all(e.excerpt.startswith('Actual source:') for s in result.suppliers for e in s.evidence))
        self.assertTrue(all(e.kind == 'page' for s in result.suppliers for e in s.evidence))
        self.assertFalse(any('external.test' in url for url in crawler.calls))
        again = asyncio.run(service.discover_suppliers(requirements(), options=DiscoveryOptions(search_concurrency=1)))
        self.assertEqual(client.calls, 4)
        self.assertTrue(all(q.cached for q in again.coverage.queries))

    def test_failed_searches_preserve_candidates_and_do_not_mean_saturation(self):
        class Client:
            calls = 0
            async def post(self, *args):
                self.calls += 1
                if self.calls > 1:
                    raise GeminiError('Unavailable')
                return response(['maker.test'])
        result = asyncio.run(GeminiDiscovery(Client(), store=self.store, crawler=FakeCrawler(fail=True))
                             .discover_suppliers(requirements(), options=DiscoveryOptions(max_queries=5)))
        self.assertEqual(len(result.suppliers), 1)
        self.assertEqual(result.suppliers[0].evidence, [])
        self.assertEqual(result.suppliers[0].crawl_status, 'unavailable')
        self.assertEqual(result.coverage.stop_reason, 'query_budget')
        self.assertEqual(len([q for q in result.coverage.queries if q.failed]), 4)

    def test_candidate_budget_retains_unresearched_leads(self):
        class Client:
            async def post(self, *args):
                return response(['first.test', 'second.test'])
        result = asyncio.run(GeminiDiscovery(Client(), store=self.store, crawler=FakeCrawler())
                             .discover_suppliers(requirements(), options=DiscoveryOptions(max_suppliers=1, max_queries=1)))
        self.assertEqual(len(result.suppliers), 1)
        self.assertEqual(len(result.deferred_suppliers), 1)
        self.assertEqual(result.coverage.pending, 1)

    def test_crawl_page_and_depth_budgets(self):
        supplier = SupplierEvidence(supplier_id='maker', name='maker', website='https://maker.test',
                                    source_urls=['https://maker.test/product'])
        crawler = FakeCrawler()
        result, issues = crawl_supplier(crawler, supplier, requirements(),
                                      DiscoveryOptions(max_pages_per_supplier=1, max_depth=0))
        self.assertEqual(len(crawler.calls), 1)
        self.assertEqual(len(result.evidence), 1)
        self.assertEqual(issues, [])

    def test_legal_identity_merges_but_similar_names_do_not(self):
        def supplier(host, vat=None):
            return SupplierEvidence(supplier_id=host, name='Identical name', website=f'https://{host}', legal_id=vat)
        self.assertEqual(len(merge_identities([supplier('a.test'), supplier('b.test')], 5)), 2)
        merged = merge_identities([supplier('a.test', 'DE123456789'), supplier('b.test', 'DE123456789')], 5)
        self.assertEqual(len(merged), 1)
        self.assertIn('a.test', merged[0].aliases)
        report = measure({'suppliers': [s.model_dump(mode='json') for s in merged]}, ['a.test', 'missing.test'])
        self.assertEqual(report['recall'], .5)
        self.assertEqual(report['missed'], ['missing.test'])


class JobTests(StoreCase):
    def test_background_job_persists_result(self):
        from backend.jobs import start_job, execute_job
        from backend.test_support import DemoDiscovery, demo_fixture
        from backend.requests import StageRequest
        payload = StageRequest.model_validate(demo_fixture()['request'])
        with patch('backend.gemini.GeminiClient'), patch('backend.discovery.GeminiDiscovery', return_value=DemoDiscovery()):
            job = start_job(self.store, payload, 'discover')
            self.assertEqual(self.store.get(job)['status'], 'queued')
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
            state = self.store.get(job)
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(len(state['result']['suppliers']), 3)

    def test_failure_retains_checkpoint(self):
        from backend.jobs import start_job, execute_job
        from backend.contracts import DiscoveryResult
        from backend.test_support import demo_fixture
        from backend.requests import StageRequest
        class Broken:
            def __init__(self, client, store, progress):
                self.progress = progress
            async def discover_suppliers(self, *args, **kwargs):
                await self.progress(DiscoveryResult())
                raise GeminiError('Provider unavailable')
        with patch('backend.gemini.GeminiClient'), patch('backend.discovery.GeminiDiscovery', Broken), self.assertLogs('backend.jobs', level='ERROR'):
            job = start_job(self.store, StageRequest.model_validate(demo_fixture()['request']), 'discover')
            self.assertEqual(self.store.get(job)['status'], 'queued')
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
            state = self.store.get(job)
        self.assertEqual(state['status'], 'failed')
        self.assertIsNotNone(state['result'])
        self.assertEqual(state['error'], 'Provider unavailable')


class IdentityRegressionTests(unittest.TestCase):
    def test_unknown_alias_cannot_merge_conflicting_legal_entities(self):
        suppliers = [
            SupplierEvidence(supplier_id='a', name='A', website='https://a.test', legal_id='DE123456789'),
            SupplierEvidence(supplier_id='b', name='B', website='https://b.test', legal_id='DE987654321'),
            SupplierEvidence(supplier_id='c', name='C', website='https://c.test', aliases=['a.test', 'b.test']),
        ]
        merged = merge_identities(suppliers, 5)
        self.assertEqual(len(merged), 2)
        self.assertEqual({s.legal_id for s in merged}, {'DE123456789', 'DE987654321'})


class CitationVolumeTests(unittest.TestCase):
    def test_long_search_response_resolves_supplier_links_after_directory_links(self):
        from backend.discovery import resolve_citations
        data = response([f'candidate{i}.test' for i in range(70)])
        with patch('backend.discovery.resolve_google_citation', side_effect=lambda url: url) as resolve:
            asyncio.run(resolve_citations(data))
        self.assertEqual(resolve.call_count, 70)


class ConcurrencyTests(StoreCase):
    def test_job_capacity_is_enforced_across_simultaneous_connections(self):
        from concurrent.futures import ThreadPoolExecutor
        for _ in range(6):
            self.store.create({})
        with ThreadPoolExecutor(max_workers=6) as pool:
            ids = list(pool.map(lambda _: self.store.claim(), range(6)))
        self.assertEqual(len([job for job in ids if job]), 2)


class ParallelSearchTests(StoreCase):
    def test_all_searches_run_concurrently_by_default_and_limit_is_configurable(self):
        for limit, expected in [(None, 4), (2, 2)]:
            class Client:
                active = maximum = count = 0
                async def post(self, *args):
                    self.count += 1
                    number = self.count
                    self.active += 1
                    self.maximum = max(self.maximum, self.active)
                    await asyncio.sleep(.02)
                    self.active -= 1
                    return response([f'maker{number}.test'])
            client = Client()
            result = asyncio.run(GeminiDiscovery(client, store=self.store, crawler=FakeCrawler()).discover_suppliers(
                requirements(), options=DiscoveryOptions(max_queries=4, search_concurrency=limit, refresh=True)))
            self.assertEqual(client.maximum, expected)
            self.assertEqual(len(result.coverage.queries), 4)
            self.assertEqual(len(result.suppliers), 4)

    def test_rate_limits_retry_but_permanent_errors_do_not(self):
        class Client:
            calls = 0
            async def post(self, *args):
                self.calls += 1
                if self.calls < 3:
                    raise GeminiError('Rate limited', status_code=429, retry_after=1)
                return response(['maker.test'])
        from unittest.mock import AsyncMock
        client = Client()
        service = GeminiDiscovery(client, store=self.store, crawler=FakeCrawler())
        with patch('backend.discovery.asyncio.sleep', new_callable=AsyncMock) as sleep:
            result = asyncio.run(service.search_with_retry({}))
        self.assertEqual(client.calls, 3)
        self.assertEqual(sleep.await_count, 2)
        self.assertEqual(result['status'], 'completed')
        class Forbidden:
            async def post(self, *args):
                raise GeminiError('Forbidden', status_code=403)
        with patch('backend.discovery.asyncio.sleep', new_callable=AsyncMock) as sleep:
            with self.assertRaises(GeminiError):
                asyncio.run(GeminiDiscovery(Forbidden(), store=self.store).search_with_retry({}))
            sleep.assert_not_called()


class LegacyImportTests(StoreCase):
    def test_import_preserves_records_and_is_idempotent(self):
        import sqlite3
        import tempfile
        from pathlib import Path
        from django.core.management import call_command
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'legacy.sqlite3'
            with sqlite3.connect(path) as source:
                source.execute('CREATE TABLE jobs(id TEXT, status TEXT, updated REAL, request TEXT, result TEXT, error TEXT)')
                source.execute('CREATE TABLE cache(key TEXT, updated REAL, value TEXT)')
                source.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                               ('a' * 64, 'running', time.time(), '{"stage":"discover"}', '{"suppliers":[]}', None))
                source.execute('INSERT INTO cache VALUES(?,?,?)', ('page:test', time.time(), '{"text":"source"}'))
            call_command('import_research_sqlite', str(path), stdout=io.StringIO())
            self.assertEqual(self.store.get('a' * 64)['status'], 'interrupted')
            self.assertEqual(self.store.cached('page:test'), {'text': 'source'})
            ResearchJob.objects.filter(access_token='a' * 64).update(status='completed', result={'new': True})
            call_command('import_research_sqlite', str(path), stdout=io.StringIO())
            self.assertEqual(self.store.get('a' * 64)['result'], {'new': True})
            with sqlite3.connect(path) as source:
                self.assertEqual(source.execute('SELECT status FROM jobs').fetchone()[0], 'running')
