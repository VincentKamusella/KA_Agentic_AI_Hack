"""Shared three-stage workflow and deterministic shortlist."""
from backend.domain.contracts import RecommendRequest, RecommendResponse


def shortlist(suppliers, evaluation, issues=()):
    eligible = sorted((a for a in evaluation.assessments if a.eligibility == "eligible"),
                      key=lambda a: (-a.preference_score, -a.evidence_coverage, a.supplier_id))
    return RecommendResponse(suppliers=suppliers, assessments=evaluation.assessments,
                             recommended_supplier_ids=[a.supplier_id for a in eligible[:3]],
                             issues=[*issues, *evaluation.issues])


class Recommender:
    def __init__(self, discovery, evaluator):
        self.discovery, self.evaluator = discovery, evaluator

    async def recommend(self, request: RecommendRequest):
        discovery = await self.discovery.discover_suppliers(request.requirements, options=request.options)
        evaluation = await self.evaluator.evaluate_suppliers(request.requirements, discovery.suppliers)
        return shortlist(discovery.suppliers, evaluation, discovery.issues)
