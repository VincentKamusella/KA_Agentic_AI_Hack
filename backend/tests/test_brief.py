"""Offline checks for purchase brief interpretation and API validation."""
import asyncio
import json
from unittest import TestCase
from unittest.mock import AsyncMock

from pydantic import ValidationError

from backend.integrations.gemini import GeminiError
from backend.research.brief import interpret_requirements
from backend.research.requests import StageRequest


def brief(**changes):
    return StageRequest.model_validate({'requirements': {
        'product': 'Aluminium containers', 'quantity': 5000,
        'delivery_country': 'Germany', **changes,
    }})


def response(criteria):
    return {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [
        {'type': 'text', 'text': json.dumps({'criteria': criteria})},
    ]}]}


class BriefTests(TestCase):
    def test_fixed_fields_generate_mandatory_checks_without_provider(self):
        client = AsyncMock()
        request = brief(quantity=2.5, quantity_unit='kg', needed_by='2027-03-15')
        result = asyncio.run(interpret_requirements(request.requirements, client))
        self.assertEqual([c.id for c in result.criteria], ['product', 'quantity', 'destination', 'deadline'])
        self.assertIn('2.5 kg', result.criteria[1].description)
        self.assertIn('2027-03-15', result.criteria[3].description)
        self.assertTrue(all(c.kind == 'mandatory' for c in result.criteria))
        self.assertEqual(request.requirements.criteria, [])
        client.post.assert_not_called()

    def test_optional_text_is_classified_and_uses_equal_weights(self):
        client = AsyncMock()
        client.post.return_value = response([
            {'description': 'EU manufacturing required', 'kind': 'mandatory'},
            {'description': 'Recyclable packaging preferred', 'kind': 'preference'},
        ])
        result = asyncio.run(interpret_requirements(brief(other_requirements=
            'EU manufacturing required; Recyclable packaging preferred').requirements, client))
        self.assertEqual([c.kind for c in result.criteria[-2:]], ['mandatory', 'preference'])
        self.assertTrue(all(c.weight == 1 for c in result.criteria))

    def test_invalid_or_invented_extraction_fails_instead_of_dropping_requirements(self):
        for value in ({'status': 'failed'}, response([]), response([
            {'description': 'ISO certification required', 'kind': 'mandatory'},
        ])):
            client = AsyncMock()
            client.post.return_value = value
            with self.subTest(value=value), self.assertRaises(GeminiError):
                asyncio.run(interpret_requirements(brief(other_requirements='EU manufacturing required').requirements, client))

    def test_explicit_reviewed_criteria_are_preserved(self):
        request = brief(criteria=[{'id': 'custom', 'description': 'Recyclable', 'kind': 'preference'}])
        client = AsyncMock()
        self.assertEqual(asyncio.run(interpret_requirements(request.requirements, client)), request.requirements)
        client.post.assert_not_called()

    def test_invalid_fixed_fields_are_rejected(self):
        for change in ({'product': '  '}, {'delivery_country': ' '}, {'quantity_unit': ' '},
                       {'quantity': True}, {'quantity': -1}, {'quantity': float('inf')},
                       {'needed_by': 'Flexible'}, {'needed_by': '2027-02-30'},
                       {'other_requirements': 'x' * 4001}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                brief(**change)
