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
        self.assertAlmostEqual(decision.probabilities['fail'], .9)
        self.assertEqual(result.metrics.calls, 1)
        self.assertEqual(result.metrics.questions, 2)
        self.assertEqual((result.metrics.pass_count, result.metrics.fail_count), (1, 1))
        self.assertEqual((result.metrics.abstained, result.metrics.below_threshold), (0, 0))

    def test_low_confidence_decisions_are_recorded_but_not_counted(self):
        evaluation = self.run_eval(FakeClient(confidence=.6))
        criterion = evaluation.assessments[0].criteria[0]
        self.assertEqual(criterion.result, 'unknown')
        self.assertFalse(any(d.counted for d in criterion.decisions))
        self.assertEqual(evaluation.metrics.below_threshold, 2)
        self.assertEqual(evaluation.metrics.counted, 0)

    def test_shortlist_preserves_decision_metrics_and_tracks_skipped_and_failed(self):
        from backend.research.pipeline import shortlist
        empty_supplier = self.supplier.model_copy(update={'supplier_id': 'empty', 'evidence': []})

        class PartialErrorClient(FakeClient):
            async def post(self, endpoint, payload):
                if '"supplier_id": "alpha"' in payload['input']:
                    raise GeminiError('Rate limited')
                return await super().post(endpoint, payload)

        third = self.supplier.model_copy(update={'supplier_id': 'ok'})
        evaluation = asyncio.run(GeminiEvaluator(PartialErrorClient({'c0_e0': 'unknown'})).evaluate_suppliers(
            self.requirements, [self.supplier, empty_supplier, third]))
        response = shortlist([self.supplier, empty_supplier, third], evaluation)
        self.assertIsNotNone(response.decision_metrics)
        self.assertEqual(response.decision_metrics.calls, 2)
        self.assertEqual(response.decision_metrics.failed_calls, 1)
        self.assertEqual(response.decision_metrics.skipped_suppliers, 1)
        self.assertEqual(response.decision_metrics.abstained, 1)
        self.assertEqual(response.decision_metrics.pass_count, 1)

    def test_relevance_screen_never_reaches_evaluation_input(self):
        client = FakeClient()
        self.supplier.fit_result, self.supplier.fit_confidence = 'pass', .99
        self.supplier.price = '$12.50 / unit'
        self.supplier.discovered_by = ['very long search query string']
        self.supplier.aliases = ['alias.example']
        self.run_eval(client)
        raw_input = client.calls[0][1]['input']
        self.assertNotIn('fit_', raw_input)
        self.assertNotIn('"price":', raw_input)
        self.assertNotIn('discovered_by', raw_input)
        self.assertNotIn('aliases', raw_input)
        self.assertNotIn('source_urls', raw_input)

    def test_combined_evaluation_scores_discovery_fit_in_one_call_and_retries_rate_limit(self):
        import json
        from unittest.mock import AsyncMock, patch

        class CombinedClient:
            def __init__(self):
                self.calls = 0

            async def post(self, endpoint, payload):
                self.calls += 1
                if self.calls == 1:
                    raise GeminiError('Rate limited', status_code=429, retry_after=0.01)
                answers = {}
                for key, q in payload['questions'].items():
                    if q['type'] == 'score':
                        answers[key] = {
                            'type': 'score',
                            'score': 2.7,
                            'legend': {'0': 'Irrelevant', '1': 'Weak', '2': 'Relevant', '3': 'Strong'},
                            'confidence': .9,
                            'probabilities': {'0': .02, '1': .03, '2': .2, '3': .75},
                        }
                    else:
                        answers[key] = {
                            'type': 'choice',
                            'choice': 'pass',
                            'confidence': .95,
                            'probabilities': {'pass': .95, 'fail': .025, 'unknown': .025},
                        }
                return {'answers': answers}

        client = CombinedClient()
        with patch('backend.evaluation.service.asyncio.sleep', new_callable=AsyncMock):
            result = asyncio.run(GeminiEvaluator(client).evaluate_suppliers(
                self.requirements,
                [self.supplier],
                discovery_prompt='Product: Steel bolts | Search focuses: steel bolts manufacturers',
            ))
        self.assertEqual(client.calls, 2)  # 1 retry + 1 combined call (not 2 separate passes)
        self.assertEqual(self.supplier.fit_rank, 1)
        self.assertEqual(self.supplier.fit_score, 90.0)
        self.assertEqual(self.supplier.fit_result, 'pass')
        self.assertEqual(result.assessments[0].eligibility, 'eligible')
        self.assertIsNotNone(result.metrics.discovery_ranking)
        self.assertEqual(result.metrics.discovery_ranking.calls, 1)

    def test_failed_call_reports_supplier_failure(self):
        events = []
        asyncio.run(GeminiEvaluator(FakeClient(error=GeminiError('Unavailable'))).evaluate_suppliers(
            self.requirements, [self.supplier], progress=events.append))
        self.assertEqual(events[3]['status'], 'failed')
        self.assertEqual(events[3]['message'], 'Unavailable')

    def test_invalid_criteria_do_not_publish_a_partial_discovery_score(self):
        class InvalidCriteria(FakeClient):
            async def post(self, endpoint, payload):
                result = await super().post(endpoint, payload)
                result['answers']['discovery_fit'] = {
                    'type': 'score', 'score': 3, 'confidence': .99,
                    'legend': {'3': 'Strong'}, 'probabilities': {'3': 1},
                }
                result['answers']['c0_e0']['probabilities']['fail'] = .99
                return result
        with self.assertLogs('backend.evaluation.service', level='WARNING') as logs:
            result = asyncio.run(GeminiEvaluator(InvalidCriteria()).evaluate_suppliers(
                self.requirements, [self.supplier], discovery_prompt='Steel bolts'))
        self.assertEqual(result.assessments, [])
        self.assertIsNone(self.supplier.fit_score)
        self.assertIn('stage=criterion_answers', logs.output[0])

    def test_rank_by_discovery_uses_generated_prompt_and_assigns_fit_rank(self):
        import json
        s_low = self.supplier.model_copy(update={'supplier_id': 'low', 'name': 'Low Fit'})
        s_high = self.supplier.model_copy(update={'supplier_id': 'high', 'name': 'High Fit'})
        s_empty = self.supplier.model_copy(update={'supplier_id': 'empty', 'name': 'No Evidence', 'evidence': []})

        class ScoreClient:
            def __init__(self):
                self.prompts = []

            async def post(self, endpoint, payload):
                data = json.loads(payload['input'])
                self.prompts.append((endpoint, data['discovery_prompt'], payload['questions']['discovery_fit']['type']))
                sid = data['supplier']['supplier_id']
                score, conf = (2.8, .92) if sid == 'high' else (1.1, .75)
                return {'answers': {'discovery_fit': {
                    'type': 'score',
                    'score': score,
                    'confidence': conf,
                    'probabilities': {'0': .02, '1': .08, '2': .2, '3': .7},
                }}}

        client = ScoreClient()
        prompt = 'Product: Steel bolts | Search focuses: steel bolts manufacturers'
        ranked, metrics = asyncio.run(GeminiEvaluator(client).rank_by_discovery(
            prompt, [s_low, s_empty, s_high]
        ))
        self.assertEqual([s.supplier_id for s in ranked], ['high', 'low', 'empty'])
        self.assertEqual([s.fit_rank for s in ranked], [1, 2, 3])
        self.assertGreater(ranked[0].fit_score, ranked[1].fit_score)
        self.assertEqual(ranked[0].fit_result, 'pass')
        self.assertEqual(ranked[1].fit_result, 'unknown')
        self.assertEqual(ranked[2].fit_result, 'fail')
        self.assertEqual(metrics.prompt, prompt)
        self.assertEqual(metrics.calls, 2)
        self.assertEqual(metrics.status, 'done')
        self.assertEqual(len(metrics.rubric), 4)
        self.assertTrue(all(p[0] == 'decisions' and p[1] == prompt and p[2] == 'score' for p in client.prompts))


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


class CriteriaSuggesterTests(unittest.TestCase):
    def test_suggest_criteria_parses_and_normalizes_suggestions(self):
        import json
        from backend.domain.contracts import SuggestCriteriaRequest
        from backend.criteria import GeminiCriteriaSuggester

        class Client:
            async def post(self, endpoint, payload):
                self.endpoint = endpoint
                self.payload = payload
                return {
                    'status': 'completed',
                    'steps': [{'type': 'model_output', 'content': [{
                        'type': 'text',
                        'text': json.dumps({'criteria': [
                            {'id': 'ISO 9001!', 'description': 'Holds ISO 9001 certification.', 'kind': 'mandatory', 'weight': 5},
                            {'id': 'ISO 9001!', 'description': 'Ships to Germany within 2 weeks.', 'kind': 'preference', 'weight': 2.5},
                        ]}),
                    }]}],
                }

        client = Client()
        result = asyncio.run(GeminiCriteriaSuggester(client).suggest_criteria(
            SuggestCriteriaRequest(product='Steel bolts', quantity=1000, delivery_country='Germany')))
        self.assertEqual(client.endpoint, 'interactions')
        self.assertEqual([c.id for c in result.criteria], ['iso-9001', 'iso-9001-2'])
        self.assertEqual(result.criteria[0].weight, 1.0)
        self.assertEqual(result.criteria[1].weight, 2.5)

    def test_suggest_criteria_rejects_empty_or_incomplete_response(self):
        from backend.domain.contracts import SuggestCriteriaRequest
        from backend.criteria import GeminiCriteriaSuggester

        class IncompleteClient:
            async def post(self, endpoint, payload):
                return {'status': 'failed', 'steps': []}

        with self.assertRaises(GeminiError):
            asyncio.run(GeminiCriteriaSuggester(IncompleteClient()).suggest_criteria(
                SuggestCriteriaRequest(product='Steel bolts')))


class SustainabilityScoringTests(unittest.TestCase):
    def setUp(self):
        self.suppliers = [
            SupplierEvidence.model_validate(s)
            for s in demo_fixture()['response']['suppliers']
        ]

    def test_internet_search_and_decision_model_score_traffic_lights(self):
        import json
        from backend.evaluation.sustainability import score_suppliers_sustainability

        class Client:
            def __init__(self):
                self.endpoints = []

            async def post(self, endpoint, payload):
                self.endpoints.append(endpoint)
                if endpoint == 'interactions':
                    line_a = 'SUPPLIER alpha: Example Alpha holds ISO 14001 and EcoVadis Gold.'
                    line_b = 'SUPPLIER beta: Example Beta publishes a general environmental policy.'
                    line_c = 'SUPPLIER gamma: Example Gamma faced environmental compliance fines.'
                    full = '\n'.join([line_a, line_b, line_c])
                    o_b = len(line_a) + 1
                    o_c = o_b + len(line_b) + 1
                    return {
                        'status': 'completed',
                        'steps': [{'type': 'model_output', 'content': [{
                            'type': 'text',
                            'text': full,
                            'annotations': [
                                {'type': 'url_citation', 'url': 'https://ecovadis.example/alpha', 'start_index': 0, 'end_index': len(line_a)},
                                {'type': 'url_citation', 'url': 'https://beta.example/esg', 'start_index': o_b, 'end_index': o_b + len(line_b)},
                                {'type': 'url_citation', 'url': 'https://news.example/gamma-fine', 'start_index': o_c, 'end_index': o_c + len(line_c)},
                            ],
                        }]}],
                    }
                data = json.loads(payload['input'])
                sid = data['supplier']['supplier_id']
                score, conf = {'alpha': (1.85, .93), 'beta': (1.0, .82), 'gamma': (0.2, .91)}[sid]
                return {'answers': {'sustainability': {
                    'type': 'score',
                    'score': score,
                    'confidence': conf,
                    'legend': {'0': 'Bad', '1': 'Ok', '2': 'Good'},
                    'probabilities': {'0': .05, '1': .15, '2': .8} if sid == 'alpha' else {'0': .8, '1': .15, '2': .05},
                }}}

        client = Client()
        scored = asyncio.run(score_suppliers_sustainability(client, None, self.suppliers))
        by_id = {s.supplier_id: s for s in scored}
        self.assertEqual(by_id['alpha'].sustainability_rating, 'good')
        self.assertEqual(by_id['beta'].sustainability_rating, 'ok')
        self.assertEqual(by_id['gamma'].sustainability_rating, 'bad')
        self.assertGreater(by_id['alpha'].sustainability_score, by_id['beta'].sustainability_score)
        self.assertGreater(by_id['beta'].sustainability_score, by_id['gamma'].sustainability_score)
        self.assertEqual(str(by_id['alpha'].sustainability_evidence[0].source_url), 'https://ecovadis.example/alpha')
        self.assertEqual(by_id['alpha'].sustainability_evidence[0].kind, 'search_summary')
        self.assertEqual(client.endpoints.count('interactions'), 1)
        self.assertEqual(client.endpoints.count('decisions'), 3)

    def test_sustainability_fields_never_reach_criterion_evaluation(self):
        supplier = self.suppliers[0].model_copy(update={
            'sustainability_rating': 'good',
            'sustainability_score': 95.0,
            'sustainability_note': 'ISO 14001 certified.',
        })
        client = FakeClient()
        req = Requirements.model_validate(demo_fixture()['request']['requirements'])
        asyncio.run(GeminiEvaluator(client).evaluate_suppliers(req, [supplier]))
        self.assertNotIn('sustainability_', client.calls[0][1]['input'])
