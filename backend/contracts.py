"""Shared wire models for discovery, evaluation, and the Django product layer."""

from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, HttpUrl, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Criterion(Contract):
    id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    kind: Literal["mandatory", "preference"]
    weight: float = Field(default=1, gt=0)


class Requirements(Contract):
    product: str = Field(min_length=1)
    quantity: int = Field(gt=0, strict=True)
    delivery_country: str = Field(min_length=1)
    criteria: list[Criterion] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_criteria(self) -> "Requirements":
        ids = [criterion.id for criterion in self.criteria]
        if len(ids) != len(set(ids)):
            raise ValueError("Criterion IDs must be unique")
        return self


class Evidence(Contract):
    id: str = Field(min_length=1)
    source_url: HttpUrl
    excerpt: str = Field(min_length=1)
    fetched_at: AwareDatetime


class SupplierEvidence(Contract):
    supplier_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    website: HttpUrl
    evidence: list[Evidence] = Field(default_factory=list)


class CriterionAssessment(Contract):
    """Mandatory scores are null; known preference scores are 0–100.

    The evaluator must resolve evidence IDs within the assessed supplier and
    return exactly one assessment per requested criterion.
    """

    criterion_id: str = Field(min_length=1)
    result: Literal["pass", "fail", "unknown"]
    score: float | None = Field(default=None, ge=0, le=100)
    evidence_ids: list[str] = Field(default_factory=list)
    explanation: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_evidence_and_score(self) -> "CriterionAssessment":
        if self.result == "unknown" and self.score is not None:
            raise ValueError("Unknown criteria cannot have a score")
        if self.result != "unknown" and not self.evidence_ids:
            raise ValueError("Pass/fail assessments require supporting evidence")
        return self


class SupplierAssessment(Contract):
    """A mandatory failure makes a supplier ineligible; otherwise a mandatory
    unknown requires verification; otherwise it is eligible.

    Preference score = sum(weight * score) / sum(all preference weights).
    Unknown preferences earn zero points; no preferences means a zero score.
    Coverage is the fraction of requested criteria with a known result, or zero
    for no criteria. Scores are not probabilities. The evaluator enforces these
    cross-record rules; field validation alone cannot establish them.
    """

    supplier_id: str = Field(min_length=1)
    eligibility: Literal["eligible", "ineligible", "needs_verification"]
    criteria: list[CriterionAssessment]
    preference_score: float = Field(ge=0, le=100)
    evidence_coverage: float = Field(ge=0, le=1)


class PipelineIssue(Contract):
    stage: Literal["discovery", "evaluation"]
    supplier_id: str | None = None
    url: HttpUrl | None = None
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    retryable: bool


class DiscoveryOptions(Contract):
    max_suppliers: int = Field(default=20, ge=1, le=100, strict=True)
    max_pages_per_supplier: int = Field(default=5, ge=1, le=20, strict=True)


class DiscoveryResult(Contract):
    suppliers: list[SupplierEvidence] = Field(default_factory=list)
    issues: list[PipelineIssue] = Field(default_factory=list)


class EvaluationResult(Contract):
    assessments: list[SupplierAssessment] = Field(default_factory=list)
    issues: list[PipelineIssue] = Field(default_factory=list)


class RecommendRequest(Contract):
    requirements: Requirements
    options: DiscoveryOptions = Field(default_factory=DiscoveryOptions)


class RecommendResponse(Contract):
    suppliers: list[SupplierEvidence]
    assessments: list[SupplierAssessment]
    recommended_supplier_ids: list[str] = Field(max_length=3)
    issues: list[PipelineIssue] = Field(default_factory=list)
