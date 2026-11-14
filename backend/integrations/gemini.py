"""Small server-only REST transport for the Gemini v1beta APIs."""
import asyncio
import json
import os
import logging
import math
import ssl
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)


class GeminiError(Exception):
    """Safe provider error with transport metadata for bounded retries."""

    def __init__(self, message, *, status_code=None, retry_after=None, error_kind=None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after
        self.error_kind = error_kind

    @property
    def retryable(self):
        return self.status_code in (429, 503) or self.error_kind in ('timeout', 'connection')


class GeminiClient:
    def __init__(self, api_key=None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not self.api_key:
            raise GeminiError("Set GEMINI_API_KEY in the project .env file or server environment, then restart the server.")
        try:
            self.search_timeout = float(os.getenv('GEMINI_SEARCH_TIMEOUT_SECONDS', '120'))
            if not math.isfinite(self.search_timeout) or not 1 <= self.search_timeout <= 600:
                raise ValueError
        except ValueError:
            raise GeminiError('GEMINI_SEARCH_TIMEOUT_SECONDS must be a number between 1 and 600.') from None

    async def post(self, endpoint, payload):
        return await asyncio.to_thread(self._post, endpoint, payload)

    def _post(self, endpoint, payload):
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/{endpoint}",
            data=json.dumps(payload).encode(),
            headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json",
                     "Api-Revision": "2026-05-20"},
            method="POST",
        )
        started = time.monotonic()
        is_search = endpoint == 'interactions' and any(
            tool.get('type') == 'google_search' for tool in payload.get('tools', []))
        timeout = self.search_timeout if is_search else 75
        logger.info("Gemini request started endpoint=%s timeout_seconds=%s", endpoint, timeout)
        try:
            # urllib's timeout bounds socket operations, not total request wall time.
            with urlopen(request, timeout=timeout) as response:
                result = json.load(response)
                logger.info("Gemini response endpoint=%s http=%s elapsed=%.1fs", endpoint, response.status, time.monotonic() - started)
        except HTTPError as exc:
            logger.info("Gemini request failed endpoint=%s http=%s", endpoint, exc.code)
            try:
                retry_after = float(exc.headers.get("Retry-After", ""))
            except (ValueError, TypeError):
                retry_after = None
            raise GeminiError(
                f"Gemini returned HTTP {exc.code}. Check API access, quota, and model availability; then retry.",
                status_code=exc.code, retry_after=retry_after, error_kind='http',
            ) from None
        except (URLError, OSError, HTTPException) as exc:
            reason = exc.reason if isinstance(exc, URLError) else exc
            kind = 'timeout' if isinstance(reason, TimeoutError) else 'tls' if isinstance(reason, ssl.SSLError) else 'connection'
            # Exception strings can include URLs or private data. Log only safe metadata.
            logger.warning(
                "Gemini transport failed endpoint=%s kind=%s error_type=%s errno=%s timeout_seconds=%s elapsed=%.1fs",
                endpoint, kind, type(reason).__name__, getattr(reason, 'errno', None), timeout, time.monotonic() - started,
            )
            message = {
                'timeout': f'Gemini timed out waiting for network data (socket timeout {timeout:g}s). Please retry.',
                'tls': 'Gemini TLS connection failed. Check certificate and network configuration.',
                'connection': 'Gemini connection failed. Check the network and retry.',
            }[kind]
            raise GeminiError(message, error_kind=kind) from None
        except (ValueError, UnicodeError):
            raise GeminiError("Gemini returned an invalid response. Please retry.") from None
        if not isinstance(result, dict):
            raise GeminiError("Gemini returned an unexpected response shape.")
        return result
