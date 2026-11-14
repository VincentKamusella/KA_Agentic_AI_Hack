"""Enqueue client requests; execute research only in the dedicated worker."""
import asyncio
import logging

from backend.contracts import DiscoveryResult, EvaluationResult, SupplierEvidence
from backend.research import LeaseLost
from backend.requests import StageRequest

logger = logging.getLogger(__name__)


def discovery_suppliers(store, token):
    job = store.get(token) if token else None
    if not job or job['status'] != 'completed' or job['request'].get('stage') not in ('discover', 'research'):
        raise ValueError('A completed discovery job is required.')
    suppliers = job['result'].get('suppliers', []) if job['result'] else []
    if not suppliers:
        raise ValueError('Discover at least one supplier first.')
    return [SupplierEvidence.model_validate(s) for s in suppliers]


def start_job(store, payload, stage='research'):
    if stage not in ('discover', 'evaluate', 'research'):
        raise ValueError('Unknown research stage.')
    if stage == 'evaluate' or payload.discovery_job_id:
        discovery_suppliers(store, payload.discovery_job_id)
        original = store.get(payload.discovery_job_id)['request']['requirements']
        if any(original[key] != getattr(payload.requirements, key) for key in ('product', 'quantity', 'delivery_country')):
            raise ValueError('Changed purchase briefs require fresh research.')
    return store.create(payload.model_dump(mode='json') | {'stage': stage})


def execute_job(store, job_id, lease_id):
    # Provider and crawler imports stay outside the HTTP request path.
    from backend.discovery import GeminiDiscovery
    from backend.evaluation import GeminiEvaluator
    from backend.gemini import GeminiClient, GeminiError
    from backend.pipeline import shortlist

    async def checkpoint(result, phase):
        data = result.model_dump(mode='json') if hasattr(result, 'model_dump') else result
        await asyncio.to_thread(store.update, job_id, lease_id=lease_id, result={**data, 'phase': phase})

    async def execute(request, client):
        stage = request['stage']
        payload = StageRequest.model_validate({k: v for k, v in request.items() if k not in ('stage', 'suppliers')})
        if payload.discovery_job_id:
            suppliers = await asyncio.to_thread(discovery_suppliers, store, payload.discovery_job_id)
            source = await asyncio.to_thread(store.get, payload.discovery_job_id)
            discovery = DiscoveryResult.model_validate({k: v for k, v in source['result'].items()
                if k in ('suppliers', 'coverage', 'issues', 'deferred_suppliers')})
            discovery.issues = [issue for issue in discovery.issues if issue.stage == 'discovery']
        else:
            async def discovery_progress(result):
                await checkpoint(result, 'discovery')
            discovery = await GeminiDiscovery(client, store=store, progress=discovery_progress).discover_suppliers(
                payload.requirements, options=payload.options)
            suppliers = discovery.suppliers
        if stage == 'discover':  # Compatibility for already queued jobs only.
            return discovery.model_dump(mode='json')
        evaluator = GeminiEvaluator(client)
        evaluation = EvaluationResult()

        def combined():
            return {**shortlist(suppliers, evaluation, discovery.issues).model_dump(mode='json'),
                    'coverage': discovery.coverage.model_dump(mode='json'),
                    'deferred_suppliers': [s.model_dump(mode='json') for s in discovery.deferred_suppliers]}

        await checkpoint(combined(), 'evaluation')
        for start in range(0, len(suppliers), 3):
            batch = await evaluator.evaluate_suppliers(payload.requirements, suppliers[start:start + 3])
            evaluation.assessments.extend(batch.assessments)
            evaluation.issues.extend(batch.issues)
            await checkpoint(combined(), 'evaluation')
        return {**combined(), 'phase': 'complete'}

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
