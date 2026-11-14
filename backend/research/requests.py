"""Validated client requests; evidence is loaded from saved discovery results."""
from pydantic import Field, model_validator

from backend.domain.contracts import Contract, DiscoveryOptions, Requirements


class StageRequest(Contract):
    requirements: Requirements
    options: DiscoveryOptions = Field(default_factory=DiscoveryOptions)
    discovery_job_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def bounded_work(self):
        if not 1 <= len(self.requirements.criteria) <= 12:
            raise ValueError("Provide between 1 and 12 criteria.")
        if any(len(c.description) > 1000 for c in self.requirements.criteria):
            raise ValueError("Criterion descriptions must be at most 1,000 characters.")
        if any(c.weight > 100 for c in self.requirements.criteria):
            raise ValueError("Criterion weights must be at most 100.")
        if len(self.requirements.product) > 1000 or len(self.requirements.delivery_country) > 100:
            raise ValueError("Product or destination is too long.")
        return self
