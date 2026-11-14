"""Per-account views of saved research: ownership, history, known suppliers."""
from web.accounts.models import SearchRecord

HISTORY_LIMIT = 50


def record_search(user, job_token, product):
    SearchRecord.objects.create(user=user, job_token=job_token, product=product[:1000])


def owns(user, job_token):
    return SearchRecord.objects.filter(user=user, job_token=job_token).exists()


def _recent(user, store):
    """This account's latest searches with their saved jobs, newest first."""
    for record in SearchRecord.objects.filter(user=user)[:HISTORY_LIMIT]:
        job = store.get(record.job_token)
        if job:  # A job can be gone from the store; then there is nothing to show.
            yield record, job


def history(user, store):
    items = []
    for record, job in _recent(user, store):
        result = job.get('result') or {}
        items.append({
            'job_id': record.job_token,
            'product': record.product,
            'created_at': record.created_at.isoformat(),
            'status': job['status'],
            'suppliers': len(result.get('suppliers') or []),
            'shortlisted': len(result.get('recommended_supplier_ids') or []) if job['status'] == 'completed' else None,
        })
    return items


def known_suppliers(user, store):
    """Every supplier from this account's searches, with its latest assessment."""
    suppliers = {}
    for record, job in _recent(user, store):
        result = job.get('result') or {}
        eligibility = {a['supplier_id']: a['eligibility'] for a in result.get('assessments') or []}
        for supplier in result.get('suppliers') or []:
            entry = suppliers.get(supplier['supplier_id'])
            if entry:  # Records arrive newest first, so the first sighting is the latest.
                entry['searches'] += 1
                continue
            suppliers[supplier['supplier_id']] = {
                'supplier_id': supplier['supplier_id'],
                'name': supplier['name'],
                'website': supplier['website'],
                'searches': 1,
                'last_seen': record.created_at.isoformat(),
                'last_product': record.product,
                'last_job_id': record.job_token,
                # None when that search did not assess the supplier.
                'last_eligibility': eligibility.get(supplier['supplier_id']) if job['status'] == 'completed' else None,
            }
    return list(suppliers.values())
