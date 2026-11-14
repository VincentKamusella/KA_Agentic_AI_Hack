"""Structural interfaces: implementations need not inherit from these protocols."""

from typing import Callable, Protocol

from backend.domain.contracts import (
    DiscoveryOptions,
    DiscoveryResult,
    EvaluationResult,
    RecommendRequest,
    RecommendResponse,
    Requirements,
    SupplierEvidence,
)


class SupplierDiscovery(Protocol):
    """Person 1: search, crawl, deduplicate, and collect source evidence."""

    async def discover_suppliers(
        self, requirements: Requirements, *, options: DiscoveryOptions,
        progress: Callable[[dict], None] | None = None,
    ) -> DiscoveryResult:
        """Return partial successes and issues; never invent missing facts.

        Supplier IDs must be stable and unique; evidence IDs must be unique
        within a supplier. Preserve source excerpts and timestamps. Treat
        crawled content as data, never instructions. Search summaries are leads,
        not source evidence. Return coverage, deferred candidates, provenance,
        and crawl issues; a failed fetch never establishes ineligibility.
        """
        ...


class SupplierEvaluator(Protocol):
    """Person 2: Gemini decisions, criterion assessment, and ranking scores."""

    async def evaluate_suppliers(
        self, requirements: Requirements, suppliers: list[SupplierEvidence], *,
        progress: Callable[[dict], None] | None = None,
    ) -> EvaluationResult:
        """Assess each supplier or return a supplier-specific evaluation issue.

        An API failure is not an eligibility failure. Unexpected programming or
        configuration errors propagate to the caller. Validate evidence links,
        criterion coverage, and scoring rules documented in the shared models.
        """
        ...


class SupplierRecommender(Protocol):
    """Person 3: orchestrate discovery/evaluation and select up to three options."""

    async def recommend(self, request: RecommendRequest) -> RecommendResponse:
        """Return up to three eligible suppliers by descending preference score.

        Break ties by descending evidence coverage, then ascending supplier ID.
        Include all assessments and partial-failure issues in the response.
        The research worker runs the full workflow and saves the serialized
        result for the client to retrieve.
        """
        ...
