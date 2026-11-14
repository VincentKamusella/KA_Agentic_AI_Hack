"""Offline behavioral tests for evidence-grounded recommendations and drafts."""
import asyncio
import copy
import json
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from backend.domain.contracts import RecommendResponse, Requirements
from backend.integrations.gemini import GeminiError
from backend.research.recommendations import GeminiRecommendationAgent, add_recommendations
from backend.tests.support import demo_fixture


def draft(supplier_id='alpha'):
    return {
        'supplier_id': supplier_id,
        'reasons': [{'text': 'Worth contacting based on the source.',
                     'evidence_ids': [f'{supplier_id}-about']}],
        'tradeoffs': ['Price and lead time need confirmation.'],
        'verification_questions': ([
            {'criterion_id': 'manufactures', 'question': 'Do you manufacture steel bolts?'},
            {'criterion_id': 'delivery', 'question': 'Can you ship to Germany?'},
        ] if supplier_id == 'gamma' else []),
        'email_subject': 'Request for quotation: steel bolts',
        'email_intro': 'Could you provide a quotation for the following purchase?',
    }


def provider_response(items):
    return {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [
        {'type': 'text', 'text': json.dumps({'summary': 'Contact Alpha first.', 'recommendations': items})},
    ]}]}


class RecommendationTests(TestCase):
    def setUp(self):
        fixture = demo_fixture()
        self.requirements = Requirements.model_validate(fixture['request']['requirements'])
        self.result = RecommendResponse.model_validate(fixture['response'])
        self.client = AsyncMock()
        self.client.post.return_value = provider_response([draft(), draft('gamma')])

    def run_agent(self):
        return asyncio.run(GeminiRecommendationAgent(self.client).recommend(self.requirements, self.result))

    def test_recommendations_preserve_grades_and_resolve_qualification(self):
        before = self.result.model_dump()
        report = self.run_agent()
        self.assertEqual(self.result.model_dump(), before)
        self.assertFalse(report.no_eligible_suppliers)
        self.assertEqual([r.qualification for r in report.recommendations],
                         ['meets_documented_requirements', 'outreach_only'])
        self.assertEqual(report.candidate_supplier_ids, ['alpha', 'gamma'])
        endpoint, payload = self.client.post.call_args.args
        self.assertEqual(endpoint, 'interactions')
        self.assertFalse(payload['store'])
        self.assertNotIn('tools', payload)
        self.assertIn('alpha-about', payload['input'])

    def test_email_contains_brief_and_every_unresolved_question(self):
        self.requirements.quantity = 2.5
        self.requirements.quantity_unit = 'kg'
        from datetime import date
        self.requirements.needed_by = date(2027, 3, 15)
        report = self.run_agent()
        email = report.recommendations[1].email_draft
        for text in ('Steel bolts', '2.5 kg', 'Germany', '2027-03-15',
                     'Do you manufacture steel bolts?', 'Can you ship to Germany?', '[Your name]'):
            self.assertIn(text, email.body)
        self.assertEqual(email.subject, draft()['email_subject'])

    def test_rejects_unknown_ineligible_duplicate_or_uncited_recommendations(self):
        bad_citation = draft()
        bad_citation['reasons'][0]['evidence_ids'] = ['gamma-about']
        missing_question = draft('gamma')
        missing_question['verification_questions'] = []
        invented_question = draft()
        invented_question['verification_questions'] = [{'criterion_id': 'invented', 'question': 'Why?'}]
        for items in ([draft('missing')], [draft('beta')], [draft(), draft()],
                      [bad_citation], [missing_question], [invented_question]):
            with self.subTest(items=items), self.assertRaises(GeminiError):
                self.client.post.return_value = provider_response(items)
                self.run_agent()

    def test_invalid_or_incomplete_provider_output_is_rejected(self):
        for response in ({'status': 'failed'}, {'status': 'completed', 'steps': []},
                         {'status': 'completed', 'steps': [{'type': 'model_output', 'content': None}]},
                         provider_response([dict(draft(), email_intro=' ')])):
            with self.subTest(response=response), self.assertRaises(GeminiError):
                self.client.post.return_value = response
                self.run_agent()

    def test_provider_schema_is_small_but_local_output_limits_still_apply(self):
        self.run_agent()
        schema = self.client.post.call_args.args[1]['response_format']['schema']
        wire = json.dumps(schema)
        for bound in ('maxLength', 'minLength', 'pattern', 'maxItems', 'minItems'):
            self.assertNotIn(bound, wire)
        self.assertIn('required', schema)
        oversized = draft()
        oversized['email_intro'] = 'x' * 2001
        for items in ([oversized], [draft()] * 4):
            self.client.post.return_value = provider_response(items)
            with self.assertRaises(GeminiError):
                self.run_agent()

    def test_no_candidates_skips_provider_and_explains_no_recommendation(self):
        self.result.assessments = [a for a in self.result.assessments if a.eligibility == 'ineligible']
        report = self.run_agent()
        self.client.post.assert_not_called()
        self.assertTrue(report.no_eligible_suppliers)
        self.assertEqual(report.recommendations, [])
        self.assertTrue(report.summary)

    def test_only_outreach_candidates_are_explicitly_unqualified(self):
        self.result.assessments = self.result.assessments[1:]
        self.client.post.return_value = provider_response([draft('gamma')])
        report = self.run_agent()
        self.assertTrue(report.no_eligible_suppliers)
        self.assertEqual(report.recommendations[0].qualification, 'outreach_only')

    def test_email_preserves_quantity_without_rounding(self):
        self.requirements.quantity = 1234567
        self.assertIn('1234567 pieces', self.run_agent().recommendations[0].email_draft.body)

    def test_transient_provider_failure_retries_once(self):
        self.client.post.side_effect = [GeminiError('Busy', status_code=429, retry_after=100),
                                        provider_response([draft()])]
        with patch('backend.research.recommendations.asyncio.sleep', new_callable=AsyncMock) as sleep:
            self.assertEqual(len(self.run_agent().recommendations), 1)
        self.assertEqual(self.client.post.await_count, 2)
        sleep.assert_awaited_once_with(10)

    def test_shared_recommender_can_run_the_final_agent(self):
        from backend.domain.contracts import RecommendRequest
        from backend.research.pipeline import Recommender
        from backend.tests.support import DemoDiscovery, DemoEvaluator
        pipeline = Recommender(DemoDiscovery(), DemoEvaluator(), GeminiRecommendationAgent(self.client))
        result = asyncio.run(pipeline.recommend(RecommendRequest(requirements=self.requirements)))
        self.assertEqual(result.recommended_supplier_ids, ['alpha'])
        self.assertEqual(len(result.recommendation_report.recommendations), 2)

    def test_provider_failure_preserves_results_with_visible_issue(self):
        before = copy.deepcopy(self.result)
        self.client.post.side_effect = GeminiError('Provider unavailable')
        asyncio.run(add_recommendations(self.requirements, self.result, GeminiRecommendationAgent(self.client)))
        self.assertIsNone(self.result.recommendation_report)
        self.assertEqual(self.result.assessments, before.assessments)
        self.assertEqual(self.result.recommended_supplier_ids, before.recommended_supplier_ids)
        self.assertEqual(self.result.issues[-1].stage, 'recommendation')
        self.assertTrue(self.result.issues[-1].retryable)
