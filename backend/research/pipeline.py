"""Shared workflow and deterministic shortlist, with optional final recommendations."""
from backend.domain.contracts import RecommendRequest, RecommendResponse


def shortlist(suppliers, evaluation, issues=()):
    fit = {s.supplier_id: s.fit_score if s.fit_score is not None else -1 for s in suppliers}
    eligible = sorted((a for a in evaluation.assessments if a.eligibility == "eligible"),
                      key=lambda a: (-a.preference_score, -a.evidence_coverage, -fit.get(a.supplier_id, -1), a.supplier_id))
    return RecommendResponse(suppliers=suppliers, assessments=evaluation.assessments,
                             recommended_supplier_ids=[a.supplier_id for a in eligible],
                             issues=[*issues, *evaluation.issues],
                             decision_metrics=evaluation.metrics)


class Recommender:
    def __init__(self, discovery, evaluator, recommendation_agent=None):
        self.discovery, self.evaluator = discovery, evaluator
        self.recommendation_agent = recommendation_agent

    async def recommend(self, request: RecommendRequest):
        discovery = await self.discovery.discover_suppliers(request.requirements, options=request.options)
        evaluation = await self.evaluator.evaluate_suppliers(request.requirements, discovery.suppliers)
        result = shortlist(discovery.suppliers, evaluation, discovery.issues)
        if self.recommendation_agent is not None:
            from backend.research.recommendations import add_recommendations
            await add_recommendations(request.requirements, result, self.recommendation_agent)
        return result
