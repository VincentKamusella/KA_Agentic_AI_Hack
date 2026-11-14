import asyncio
import unittest
from unittest.mock import patch

from backend.discovery.benchmark import measure
from backend.discovery.crawler import CrawlError, Page, crawl_supplier
from backend.discovery.service import GeminiDiscovery, extract_candidates, merge_identities, search_plan
from backend.domain.contracts import DiscoveryOptions, Requirements, SupplierEvidence
from backend.integrations.gemini import GeminiError
from backend.tests.base import StoreCase


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
        self.assertIn('precision steel bolts', result.coverage.discovery_prompt)
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
        from backend.discovery.service import resolve_citations
        data = response([f'candidate{i}.test' for i in range(70)])
        with patch('backend.discovery.service.resolve_google_citation', side_effect=lambda url: url) as resolve:
            asyncio.run(resolve_citations(data))
        self.assertEqual(resolve.call_count, 70)


class ParallelSearchTests(StoreCase):
    def test_rolling_pool_refills_before_slow_search_finishes(self):
        async def exercise():
            release = asyncio.Event()
            observed = []

            class Service(GeminiDiscovery):
                calls = 0
                async def search_query(self, spec, req, options, known, directories):
                    from backend.domain.contracts import QueryCoverage
                    self.calls += 1
                    number = self.calls
                    if number == 1:
                        await release.wait()
                    elif number == 3:
                        observed.extend(known)
                        release.set()
                    supplier = SupplierEvidence(supplier_id=str(number), name=str(number),
                                                website=f'https://maker{number}.test')
                    return QueryCoverage(query=spec[0], country=spec[1], language=spec[2], source_type=spec[3]), [supplier], [], []

            service = Service(None, store=self.store, crawler=FakeCrawler())
            result = await asyncio.wait_for(service.discover_suppliers(requirements(),
                options=DiscoveryOptions(max_queries=3, search_concurrency=2)), timeout=2)
            self.assertIn('maker2.test', observed)
            self.assertEqual(len(result.coverage.queries), 3)

        asyncio.run(exercise())

    def test_transport_errors_retry_once_and_tls_errors_do_not(self):
        from unittest.mock import AsyncMock
        for kind, expected in [('timeout', 2), ('connection', 2), ('tls', 1)]:
            client = AsyncMock()
            client.post.side_effect = GeminiError('Transport failed', error_kind=kind)
            with self.subTest(kind=kind), patch('backend.discovery.service.asyncio.sleep', new_callable=AsyncMock), self.assertRaises(GeminiError):
                asyncio.run(GeminiDiscovery(client, store=self.store).search_with_retry({}))
            self.assertEqual(client.post.await_count, expected)

    def test_search_concurrency_is_bounded_by_default_and_configurable(self):
        for limit, expected in [(None, 3), (2, 2), (4, 4)]:
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
        with patch('backend.discovery.service.asyncio.sleep', new_callable=AsyncMock) as sleep:
            result = asyncio.run(service.search_with_retry({}))
        self.assertEqual(client.calls, 3)
        self.assertEqual(sleep.await_count, 2)
        self.assertEqual(result['status'], 'completed')
        class Forbidden:
            async def post(self, *args):
                raise GeminiError('Forbidden', status_code=403)
        with patch('backend.discovery.service.asyncio.sleep', new_callable=AsyncMock) as sleep:
            with self.assertRaises(GeminiError):
                asyncio.run(GeminiDiscovery(Forbidden(), store=self.store).search_with_retry({}))
            sleep.assert_not_called()
