"""Contract checks that require no database or external API access."""

from unittest import TestCase

from pydantic import ValidationError

from backend.tests.support import demo_fixture

from backend.domain.contracts import CriterionAssessment, RecommendRequest, RecommendResponse


class ContractTests(TestCase):
    def setUp(self):
        self.fixture = demo_fixture()

    def test_fixture_round_trips_through_json(self):
        for model, key in ((RecommendRequest, "request"), (RecommendResponse, "response")):
            with self.subTest(model=model.__name__):
                value = model.model_validate(self.fixture[key])
                self.assertEqual(model.model_validate_json(value.model_dump_json()), value)
        response = RecommendResponse.model_validate(self.fixture["response"])
        self.assertEqual(
            {item.eligibility for item in response.assessments},
            {"eligible", "ineligible", "needs_verification"},
        )

    def test_duplicate_criteria_are_rejected(self):
        request = self.fixture["request"]
        request["requirements"]["criteria"].append(request["requirements"]["criteria"][0])
        with self.assertRaises(ValidationError):
            RecommendRequest.model_validate(request)

    def test_invalid_assessments_are_rejected(self):
        base = dict(criterion_id="delivery", result="pass", score=100,
                    evidence_ids=["alpha-about"], explanation="Ships to Germany.")
        for changes in ({"score": 101}, {"score": float("nan")},
                        {"result": "unknown"}, {"evidence_ids": []}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                CriterionAssessment.model_validate(base | changes)

    def test_unknown_and_malformed_request_fields_are_rejected(self):
        for changes in ({"quantity": 0}, {"quantity": True}, {"unexpected": "value"}):
            request = self.fixture["request"] | {
                "requirements": self.fixture["request"]["requirements"] | changes
            }
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                RecommendRequest.model_validate(request)
