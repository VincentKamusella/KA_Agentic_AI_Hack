"""Enqueue client requests; execute research only in the dedicated worker."""
import asyncio
import logging
import time

from backend.domain.contracts import DiscoveryRankingMetrics, DiscoveryResult, EvaluationResult, SupplierEvidence
from backend.persistence.store import LeaseLost
from backend.research.requests import StageRequest

logger = logging.getLogger(__name__)


def discovery_suppliers(store, token):
    job = store.get(token) if token else None
    result = (job or {}).get('result') or {}
    discovery_ready = job and (
        job['status'] == 'completed'
        or (job['status'] in ('failed', 'interrupted') and result.get('phase') in ('evaluation', 'recommendation', 'complete'))
    )
    if not discovery_ready or job['request'].get('stage') not in ('discover', 'research'):
        raise ValueError('A completed discovery job is required.')
    suppliers = result.get('suppliers', [])
    if not suppliers:
        raise ValueError('Discover at least one supplier first.')
    return [SupplierEvidence.model_validate(s) for s in suppliers]


def start_job(store, payload, stage='research'):
    if stage not in ('discover', 'evaluate', 'research'):
        raise ValueError('Unknown research stage.')
    if stage == 'evaluate' or payload.discovery_job_id:
        discovery_suppliers(store, payload.discovery_job_id)
        from backend.domain.contracts import Requirements
        original = Requirements.model_validate(store.get(payload.discovery_job_id)['request']['requirements'])
        if any(getattr(original, key) != getattr(payload.requirements, key)
               for key in ('product', 'quantity', 'quantity_unit', 'delivery_country', 'needed_by', 'other_requirements')):
            raise ValueError('Changed purchase briefs require fresh research.')
    return store.create(payload.model_dump(mode='json') | {'stage': stage})


def execute_job(store, job_id, lease_id):
    # Provider and crawler imports stay outside the HTTP request path.
    from backend.discovery.service import GeminiDiscovery
    from backend.evaluation.service import (
        DISCOVERY_RUBRIC,
        GeminiEvaluator,
        assign_fit_ranks,
        build_decision_metrics,
    )
    from backend.evaluation.sustainability import score_suppliers_sustainability
    from backend.integrations.gemini import GeminiClient, GeminiError
    from backend.research.pipeline import shortlist
    from backend.research.recommendations import GeminiRecommendationAgent, add_recommendations

    interpreted = None

    async def checkpoint(result, phase):
        data = result.model_dump(mode='json') if hasattr(result, 'model_dump') else result
        await asyncio.to_thread(store.update, job_id, lease_id=lease_id, result={**data, 'phase': phase,
            'requirements': interpreted.model_dump(mode='json') if interpreted else None})

    async def execute(request, client):
        nonlocal interpreted
        from backend.research.brief import interpret_requirements
        stage = request['stage']
        payload = StageRequest.model_validate({k: v for k, v in request.items() if k not in ('stage', 'suppliers')})
        await checkpoint({}, 'interpreting')
        interpreted = await interpret_requirements(payload.requirements, client)
        payload.requirements = interpreted
        await checkpoint({}, 'interpreting')
        discovery_ranking = None
        if payload.discovery_job_id:
            suppliers = await asyncio.to_thread(discovery_suppliers, store, payload.discovery_job_id)
            source = await asyncio.to_thread(store.get, payload.discovery_job_id)
            discovery = DiscoveryResult.model_validate({k: v for k, v in source['result'].items()
                if k in ('suppliers', 'coverage', 'issues', 'deferred_suppliers')})
            discovery.issues = [issue for issue in discovery.issues if issue.stage == 'discovery']
            prior_ranking = (source['result'].get('decision_metrics') or {}).get('discovery_ranking')
            if prior_ranking:
                discovery_ranking = DiscoveryRankingMetrics.model_validate(prior_ranking)
        else:
            async def discovery_progress(result):
                await checkpoint(result, 'discovery')
            discovery = await GeminiDiscovery(client, store=store, progress=discovery_progress).discover_suppliers(
                payload.requirements, options=payload.options)
            suppliers = discovery.suppliers
        if stage == 'discover':  # Compatibility for already queued jobs only.
            return {**discovery.model_dump(mode='json'), 'requirements': interpreted.model_dump(mode='json')}
        evaluator = GeminiEvaluator(client)
        discovery_prompt = None
        if not payload.discovery_job_id and hasattr(evaluator, 'rank_by_discovery') and suppliers:
            discovery_prompt = discovery.coverage.discovery_prompt or payload.requirements.product
        evaluation = EvaluationResult()
        supplier_metrics = []
        eval_started = time.monotonic()

        def combined():
            return {**shortlist(suppliers, evaluation, discovery.issues).model_dump(mode='json'),
                    'requirements': interpreted.model_dump(mode='json'),
                    'coverage': discovery.coverage.model_dump(mode='json'),
                    'deferred_suppliers': [s.model_dump(mode='json') for s in discovery.deferred_suppliers]}

        evaluation.metrics = build_decision_metrics([], 0.0, discovery_ranking=discovery_ranking)
        await checkpoint(combined(), 'evaluation')
        needs_sust = (
            [
                s for s in suppliers
                if s.sustainability_rating is None
                or not (s.sustainability_probabilities and 'certifications' in s.sustainability_probabilities)
            ]
            if hasattr(evaluator, 'rank_by_discovery') and suppliers
            else []
        )
        sust_task = (
            asyncio.create_task(score_suppliers_sustainability(
                client, store, needs_sust, refresh=payload.options.refresh
            ))
            if needs_sust
            else None
        )
        for start in range(0, len(suppliers), 6):
            batch_suppliers = suppliers[start:start + 6]
            batch = (
                await evaluator.evaluate_suppliers(payload.requirements, batch_suppliers, discovery_prompt=discovery_prompt)
                if discovery_prompt is not None
                else await evaluator.evaluate_suppliers(payload.requirements, batch_suppliers)
            )
            evaluation.assessments.extend(batch.assessments)
            evaluation.issues.extend(batch.issues)
            if batch.metrics:
                supplier_metrics.extend(batch.metrics.suppliers)
            if discovery_prompt is not None:
                assign_fit_ranks(suppliers)
                scored_calls = sum(bool(s.evidence) for s in suppliers[:start + 6])
                failed_calls = sum(m.status == 'failed' for m in supplier_metrics)
                status = 'skipped' if scored_calls == 0 else 'failed' if failed_calls == scored_calls else 'done'
                discovery_ranking = DiscoveryRankingMetrics(
                    prompt=discovery_prompt, rubric=DISCOVERY_RUBRIC, calls=scored_calls,
                    elapsed_seconds=round(time.monotonic() - eval_started, 2), status=status,
                    message=(
                        'No crawled source excerpts available for discovery ranking.' if scored_calls == 0
                        else f'{failed_calls} supplier ranking call(s) failed.' if failed_calls else None
                    ),
                )
            evaluation.metrics = build_decision_metrics(
                supplier_metrics, round(time.monotonic() - eval_started, 2), discovery_ranking=discovery_ranking
            )
            await checkpoint(combined(), 'evaluation')
        if sust_task is not None:
            sust_scored = await sust_task
            for target, scored in zip(needs_sust, sust_scored):
                target.sustainability_rating = scored.sustainability_rating
                target.sustainability_score = scored.sustainability_score
                target.sustainability_confidence = scored.sustainability_confidence
                target.sustainability_probabilities = scored.sustainability_probabilities
                target.sustainability_evidence = scored.sustainability_evidence
                target.sustainability_note = scored.sustainability_note
        if discovery_prompt is not None:
            suppliers = assign_fit_ranks(suppliers)
            discovery.suppliers = suppliers
        await checkpoint(combined(), 'recommendation')
        final = await add_recommendations(
            payload.requirements, shortlist(suppliers, evaluation, discovery.issues),
            GeminiRecommendationAgent(client),
        )
        return {**combined(), **final.model_dump(mode='json'), 'phase': 'complete'}

    try:
        request = store.claimed_request(job_id, lease_id)
        result = asyncio.run(execute(request, GeminiClient()))
        store.update(job_id, lease_id=lease_id, status='completed', result=result)
    except LeaseLost:
        return
    except Exception as exc:
        logger.exception('Research job failed id=%s', job_id)
        error = str(exc) if isinstance(exc, GeminiError) else 'Research failed. Saved partial results are available; start a new job to retry.'
        try:
            store.update(job_id, lease_id=lease_id, status='failed', error=error)
        except LeaseLost:
            pass
