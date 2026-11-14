"""Synthetic fixtures exclusively for offline tests."""
import json
from pathlib import Path
from backend.domain.contracts import CriterionAssessment, DiscoveryResult, EvaluationResult
from backend.evaluation.service import aggregate

def demo_fixture():
    return json.loads((Path(__file__).resolve().parents[2] / "fixtures/example_pipeline.json").read_text())


class DemoDiscovery:
    async def discover_suppliers(self, requirements, *, options):
        fixture = demo_fixture()
        return DiscoveryResult.model_validate({"suppliers": fixture["response"]["suppliers"][:options.max_suppliers]})


class DemoEvaluator:
    """Saved synthetic assessments; changed descriptions deliberately abstain."""
    async def evaluate_suppliers(self, requirements, suppliers):
        fixture = demo_fixture()
        reference = {c["id"]: c["description"] for c in fixture["request"]["requirements"]["criteria"]}
        saved = {a["supplier_id"]: a for a in fixture["response"]["assessments"]}
        result = []
        for supplier in suppliers:
            original = {c["criterion_id"]: c for c in saved[supplier.supplier_id]["criteria"]}
            criteria = []
            for c in requirements.criteria:
                known = reference.get(c.id) == c.description and requirements.product.casefold() == "steel bolts"
                assessment = CriterionAssessment.model_validate(original[c.id]) if known else CriterionAssessment(
                    criterion_id=c.id, result="unknown", explanation="This edited criterion has no saved demo assessment. Use live mode to assess it.")
                assessment.score = (100 if assessment.result == "pass" else 0) if c.kind == "preference" and assessment.result != "unknown" else None
                criteria.append(assessment)
            result.append(aggregate(requirements, supplier.supplier_id, criteria))
        return EvaluationResult(assessments=result)
