# QuotePilot

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Procurement specialists at small and medium-sized manufacturers finding suppliers for a purchase.

## Product Purpose
Discover suppliers, evaluate source evidence against requirements, and present an explainable shortlist. The user confirmed this flow supersedes the older quotation-upload guide.

## Capabilities and Constraints
Existing Django and Pydantic application. Gemini Decisions API preselects candidates. Code enforces mandatory gates and preference ranking. This first version has no purchasing, outbound email, accounts, or ERP integration.

## Evidence on Hand
fixtures/example_pipeline.json contains fictional suppliers, never real customer evidence.

## Product Principles
Missing evidence stays unknown. Mandatory failures cannot be offset by a preference score. Every assessment exposes its evidence. Human verification precedes purchasing.
