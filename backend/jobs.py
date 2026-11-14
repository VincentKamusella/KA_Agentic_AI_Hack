"""Bounded background jobs for the single-host prototype deployment.

PostgreSQL admission control is shared across web processes. A worker restart leaves
readable checkpoints; repeating discovery reuses cached searches and source pages.
"""
import asyncio
import logging
import threading

from backend.contracts import EvaluationResult
from backend.discovery import GeminiDiscovery
from backend.evaluation import GeminiEvaluator
from backend.gemini import GeminiClient, GeminiError
from backend.pipeline import shortlist

logger = logging.getLogger(__name__)


def start_job(store, payload, stage):
    # Fail immediately on missing credentials, before allocating a running job.
    client = GeminiClient()
    job_id = store.create(payload.model_dump(mode='json') | {'stage': stage})

    async def checkpoint(result):
        await asyncio.to_thread(store.update, job_id, result=result.model_dump(mode='json'))

    async def execute():
        if stage == 'discover':
            return await GeminiDiscovery(client, store=store, progress=checkpoint).discover_suppliers(
                payload.requirements, options=payload.options)
        evaluator = GeminiEvaluator(client)
        evaluation = EvaluationResult()
        for start in range(0, len(payload.suppliers), 3):
            batch = await evaluator.evaluate_suppliers(payload.requirements, payload.suppliers[start:start + 3])
            evaluation.assessments.extend(batch.assessments)
            evaluation.issues.extend(batch.issues)
            await checkpoint(shortlist(payload.suppliers, evaluation))
        return shortlist(payload.suppliers, evaluation)

    def work():
        try:
            result = asyncio.run(execute())
            store.update(job_id, status='completed', result=result.model_dump(mode='json'))
        except GeminiError as exc:
            store.update(job_id, status='failed', error=str(exc))
        except Exception:
            logger.exception('Research job failed id=%s', job_id)
            store.update(job_id, status='failed', error='Research failed. Saved partial results are available; retry the search.')

    try:
        threading.Thread(target=work, name=f'research-{job_id[:8]}', daemon=True).start()
    except Exception:
        store.update(job_id, status='failed', error='Could not start the research worker. Retry.')
        raise
    return job_id
