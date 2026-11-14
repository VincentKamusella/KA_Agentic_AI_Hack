import asyncio
import copy
import unittest

from backend.domain.contracts import Requirements, SupplierEvidence
from backend.discovery.service import extract_candidates
from backend.evaluation.service import GeminiEvaluator
from backend.integrations.gemini import GeminiError
from backend.research.pipeline import Recommender
from backend.tests.support import DemoDiscovery, DemoEvaluator, demo_fixture


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
        from backend.domain.contracts import RecommendRequest
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

    def test_progress_events_and_raw_decisions_are_reported(self):
        events = []
        result = asyncio.run(GeminiEvaluator(FakeClient({'c0_e0': 'fail'}, confidence=.9)).evaluate_suppliers(
            self.requirements, [self.supplier], progress=events.append))
        self.assertEqual([(e['type'], e['status']) for e in events], [
            ('step', 'running'), ('supplier', 'queued'), ('supplier', 'running'),
            ('supplier', 'done'), ('step', 'done')])
        self.assertTrue(all(e['step'] == 'assess' for e in events))
        answers = events[3]['answers']
        self.assertEqual(len(answers), len(self.requirements.criteria) * len(self.supplier.evidence))
        self.assertEqual(answers[0]['choice'], 'fail')
        decision = result.assessments[0].criteria[0].decisions[0]
        self.assertEqual((decision.choice, decision.confidence, decision.counted), ('fail', .9, True))

    def test_low_confidence_decisions_are_recorded_but_not_counted(self):
        criterion = self.run_eval(FakeClient(confidence=.6)).assessments[0].criteria[0]
        self.assertEqual(criterion.result, 'unknown')
        self.assertFalse(any(d.counted for d in criterion.decisions))

    def test_relevance_screen_never_reaches_evaluation_input(self):
        client = FakeClient()
        self.supplier.fit_result, self.supplier.fit_confidence = 'pass', .99
        self.supplier.price = '$12.50 / unit'
        self.run_eval(client)
        self.assertNotIn('fit_', client.calls[0][1]['input'])
        self.assertNotIn('"price":', client.calls[0][1]['input'])

    def test_extract_price_from_cited_excerpts(self):
        from backend.discovery import citations_to_suppliers, extract_price
        self.assertEqual(extract_price(['Precision bolts at $0.45 per unit.']), '$0.45 per unit')
        self.assertEqual(extract_price(['Bulk pack: €120.00 / box']), '€120.00 / box')
        self.assertEqual(extract_price(['Unit cost 14.50 USD each']), '14.50 USD each')
        self.assertIsNone(extract_price(['ISO 9001 certified for 1000 units.']))
        response = {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{
            'type': 'text', 'text': 'Steel bolts start at $12.50 - $15.00 per box.',
            'annotations': [dict(type='url_citation', url='https://alpha.example/pricing', start_index=0, end_index=45)],
        }]}]}
        result = citations_to_suppliers(response, DiscoveryOptions())
        self.assertEqual(result.suppliers[0].price, '$12.50 - $15.00 per box')

    def test_failed_call_reports_supplier_failure(self):
        events = []
        asyncio.run(GeminiEvaluator(FakeClient(error=GeminiError('Unavailable'))).evaluate_suppliers(
            self.requirements, [self.supplier], progress=events.append))
        self.assertEqual(events[3]['status'], 'failed')
        self.assertEqual(events[3]['message'], 'Unavailable')


class DiscoveryRelevanceTests(unittest.TestCase):
    response = {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{
        'type': 'text', 'text': 'We make bolts.',
        'annotations': [dict(type='url_citation', url='https://alpha.example/about', start_index=0, end_index=14)],
    }]}]}

    def discover(self, decisions):
        from backend.discovery import GeminiDiscovery

        class Client:
            async def post(self, endpoint, payload):
                if endpoint == 'interactions':
                    return copy.deepcopy(DiscoveryRelevanceTests.response)
                if isinstance(decisions, Exception):
                    raise decisions
                return {'answers': {key: decisions for key in payload['questions']}}

        events = []
        requirements = Requirements.model_validate(demo_fixture()['request']['requirements'])
        result = asyncio.run(GeminiDiscovery(Client()).discover_suppliers(
            requirements, options=DiscoveryOptions(), progress=events.append))
        return result, events

    def test_relevance_screen_labels_candidates(self):
        result, events = self.discover({'choice': 'pass', 'confidence': .91})
        self.assertEqual((result.suppliers[0].fit_result, result.suppliers[0].fit_confidence), ('pass', .91))
        self.assertEqual([(e['step'], e['status']) for e in events], [
            ('search', 'running'), ('search', 'done'), ('sources', 'running'), ('sources', 'done'),
            ('fit', 'running'), ('fit', 'done')])
        self.assertEqual(events[-1]['source'], 'decision')

    def test_malformed_or_failed_screen_leaves_candidates_unscreened(self):
        result, _ = self.discover({'choice': 'maybe', 'confidence': 2})
        self.assertIsNone(result.suppliers[0].fit_result)
        result, events = self.discover(GeminiError('down'))
        self.assertEqual(len(result.suppliers), 1)
        self.assertEqual(events[-1]['status'], 'failed')
        self.assertIn('relevance_unavailable', [i.code for i in result.issues])

    def test_discovery_sorts_candidates_by_decision_model_fit(self):
        from backend.discovery import GeminiDiscovery

        response = {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{
            'type': 'text',
            'text': 'Fail high. Unknown. Pass low. Unscreened. Pass high. Fail low.',
            'annotations': [
                dict(type='url_citation', url='https://fail-high.example/a', start_index=0, end_index=10),
                dict(type='url_citation', url='https://unknown.example/a', start_index=11, end_index=19),
                dict(type='url_citation', url='https://pass-low.example/a', start_index=20, end_index=29),
                dict(type='url_citation', url='https://unscreened.example/a', start_index=30, end_index=41),
                dict(type='url_citation', url='https://pass-high.example/a', start_index=42, end_index=52),
                dict(type='url_citation', url='https://fail-low.example/a', start_index=53, end_index=62),
            ],
        }]}]}
        answers_by_host = {
            'fail-high.example': {'choice': 'fail', 'confidence': .96},
            'unknown.example': {'choice': 'unknown', 'confidence': .80},
            'pass-low.example': {'choice': 'pass', 'confidence': .72},
            'pass-high.example': {'choice': 'pass', 'confidence': .95},
            'fail-low.example': {'choice': 'fail', 'confidence': .60},
        }

        class Client:
            async def post(self, endpoint, payload):
                if endpoint == 'interactions':
                    return copy.deepcopy(response)
                suppliers_in = json.loads(payload['input'])['suppliers']
                id_to_name = {s['supplier_id']: s['name'] for s in suppliers_in}
                return {'answers': {
                    sid: answers_by_host[name]
                    for sid, name in id_to_name.items() if name in answers_by_host
                }}

        import json
        requirements = Requirements.model_validate(demo_fixture()['request']['requirements'])
        result = asyncio.run(GeminiDiscovery(Client()).discover_suppliers(
            requirements, options=DiscoveryOptions()))
        self.assertEqual(
            [s.name for s in result.suppliers],
            [
                'pass-high.example',
                'pass-low.example',
                'unknown.example',
                'unscreened.example',
                'fail-low.example',
                'fail-high.example',
            ],
        )


class CitationRedirectTests(unittest.TestCase):
    def test_google_redirect_is_resolved_without_fetching_destination(self):
        from unittest.mock import patch
        from urllib.error import HTTPError
        from backend.discovery.service import resolve_google_citation
        url = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/test"
        with patch("backend.discovery.service.build_opener") as factory:
            factory.return_value.open.side_effect = HTTPError(url, 302, "Found", {"Location": "https://supplier.example/products"}, None)
            self.assertEqual(resolve_google_citation(url), "https://supplier.example/products")
            self.assertEqual(factory.return_value.open.call_count, 1)
            self.assertEqual(factory.return_value.open.call_args.args[0].method, "HEAD")

    def test_other_hosts_are_never_fetched(self):
        from unittest.mock import patch
        from backend.discovery.service import resolve_google_citation
        with patch("backend.discovery.service.build_opener") as factory:
            for url in ["http://127.0.0.1/private", "https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/test"]:
                self.assertEqual(resolve_google_citation(url), url)
            factory.assert_not_called()
