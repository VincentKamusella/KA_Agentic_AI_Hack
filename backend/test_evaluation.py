import asyncio
import copy
import unittest

from backend.contracts import Requirements, SupplierEvidence
from backend.discovery import extract_candidates
from backend.evaluation import GeminiEvaluator
from backend.gemini import GeminiError
from backend.pipeline import Recommender
from backend.test_support import DemoDiscovery, DemoEvaluator, demo_fixture


class FakeClient:
    def __init__(self, choices=None, confidence=.95, error=None):
        self.choices, self.confidence, self.error = choices or {}, confidence, error
        self.calls = []

    async def post(self, endpoint, payload):
        self.calls.append((endpoint, payload))
        if self.error:
            raise self.error
        answers = {}
        for key in payload['questions']:
            choice = self.choices.get(key, 'pass')
            probabilities = {option: (self.confidence if option == choice else (1-self.confidence)/2)
                             for option in ('pass', 'fail', 'unknown')}
            answers[key] = dict(type='choice', choice=choice, confidence=self.confidence, probabilities=probabilities)
        return {'answers': answers}


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        fixture = demo_fixture()
        self.requirements = Requirements.model_validate(fixture['request']['requirements'])
        self.supplier = SupplierEvidence.model_validate(fixture['response']['suppliers'][0])

    def run_eval(self, client):
        return asyncio.run(GeminiEvaluator(client).evaluate_suppliers(self.requirements, [self.supplier]))

    def test_mandatory_fail_cannot_win_on_preference(self):
        result = self.run_eval(FakeClient({'c0_e0': 'fail'})).assessments[0]
        self.assertEqual(result.eligibility, 'ineligible')
        self.assertEqual(result.preference_score, 100)
        self.assertIsNone(result.criteria[0].score)

    def test_unknown_and_low_confidence_require_verification(self):
        for client in (FakeClient({'c0_e0': 'unknown'}), FakeClient(confidence=.60)):
            result = self.run_eval(client).assessments[0]
            self.assertEqual(result.eligibility, 'needs_verification')
            self.assertEqual(result.criteria[0].result, 'unknown')

    def test_conflicting_sources_abstain(self):
        evidence = self.supplier.evidence[0].model_copy(update={'id': 'contradiction'})
        self.supplier.evidence.append(evidence)
        result = self.run_eval(FakeClient({'c0_e1': 'fail'})).assessments[0]
        self.assertEqual(result.eligibility, 'needs_verification')
        self.assertEqual(set(result.criteria[0].evidence_ids), {'alpha-about', 'contradiction'})

    def test_no_evidence_remains_unknown_without_provider_call(self):
        self.supplier.evidence = []
        client = FakeClient()
        result = self.run_eval(client).assessments[0]
        self.assertEqual(result.evidence_coverage, 0)
        self.assertEqual(client.calls, [])

    def test_provider_error_is_not_supplier_failure(self):
        result = self.run_eval(FakeClient(error=GeminiError('Unavailable')))
        self.assertEqual(result.assessments, [])
        self.assertEqual(result.issues[0].supplier_id, self.supplier.supplier_id)
        self.assertTrue(result.issues[0].retryable)

    def test_incomplete_answers_are_rejected(self):
        class Incomplete(FakeClient):
            async def post(self, endpoint, payload):
                return {'answers': {}}
        self.assertEqual(self.run_eval(Incomplete()).assessments, [])

    def test_probability_corruption_is_rejected(self):
        class Corrupt(FakeClient):
            async def post(self, endpoint, payload):
                result = await super().post(endpoint, payload)
                result['answers']['c0_e0']['probabilities']['fail'] = .99
                return result
        self.assertEqual(self.run_eval(Corrupt()).assessments, [])

    def test_preference_only_brief_follows_shared_eligibility_contract(self):
        self.requirements.criteria = [self.requirements.criteria[1]]
        self.assertEqual(self.run_eval(FakeClient()).assessments[0].eligibility, 'eligible')

    def test_demo_scenario_recomputes_gates(self):
        from backend.contracts import RecommendRequest
        request = RecommendRequest.model_validate(demo_fixture()['request'])
        recommender = Recommender(DemoDiscovery(), DemoEvaluator())
        initial = asyncio.run(recommender.recommend(request))
        self.assertEqual(initial.recommended_supplier_ids, ['alpha'])
        request.requirements.criteria[0].kind = 'preference'
        request.requirements.criteria[1].kind = 'mandatory'
        changed = asyncio.run(recommender.recommend(request))
        self.assertEqual(changed.recommended_supplier_ids, ['alpha', 'beta'])
        request.requirements.criteria[1].description = 'An entirely new requirement'
        self.assertEqual(asyncio.run(recommender.recommend(request)).recommended_supplier_ids, [])

    def test_weighted_unknown_preferences_stay_in_denominator(self):
        self.requirements.criteria.append(self.requirements.criteria[1].model_copy(update={'id':'other', 'weight':3}))
        result = self.run_eval(FakeClient({'c2_e0':'unknown'})).assessments[0]
        self.assertEqual(result.preference_score, 25)

    def test_discovery_accepts_cited_urls_as_leads_only_and_deduplicates(self):
        response = {'steps':[{'type':'model_output','content':[{
            'type':'text','text':'We make bolts. Unsupported claims.',
            'annotations': [dict(type='url_citation',url='https://alpha.example/about',start_index=0,end_index=14)] * 2
        }]}]}
        suppliers, _ = extract_candidates(response, "bolts")
        self.assertEqual(len(suppliers), 1)
        self.assertEqual(len(suppliers[0].source_urls), 1)
        self.assertEqual(suppliers[0].evidence, [])
        broken = copy.deepcopy(response)
        broken['steps'][0]['content'][0]['annotations'][0]['url'] = 'javascript:alert(1)'
        broken['steps'][0]['content'][0]['annotations'].pop()
        self.assertFalse(extract_candidates(broken, "bolts")[0])


class CitationRedirectTests(unittest.TestCase):
    def test_google_redirect_is_resolved_without_fetching_destination(self):
        from unittest.mock import patch
        from urllib.error import HTTPError
        from backend.discovery import resolve_google_citation
        url = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/test"
        with patch("backend.discovery.build_opener") as factory:
            factory.return_value.open.side_effect = HTTPError(url, 302, "Found", {"Location": "https://supplier.example/products"}, None)
            self.assertEqual(resolve_google_citation(url), "https://supplier.example/products")
            self.assertEqual(factory.return_value.open.call_count, 1)
            self.assertEqual(factory.return_value.open.call_args.args[0].method, "HEAD")

    def test_other_hosts_are_never_fetched(self):
        from unittest.mock import patch
        from backend.discovery import resolve_google_citation
        with patch("backend.discovery.build_opener") as factory:
            for url in ["http://127.0.0.1/private", "https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/test"]:
                self.assertEqual(resolve_google_citation(url), url)
            factory.assert_not_called()
