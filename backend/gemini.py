"""Small server-only REST transport for the Gemini v1beta APIs."""
import asyncio
import json
import os
import logging
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)


class GeminiError(Exception):
    """Safe provider error, suitable for returning to the browser."""


class GeminiClient:
    def __init__(self, api_key=None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not self.api_key:
            raise GeminiError("Set GEMINI_API_KEY in the project .env file or server environment, then restart the server.")

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
        logger.info("Gemini request started endpoint=%s", endpoint)
        try:
            with urlopen(request, timeout=75) as response:
                result = json.load(response)
                logger.info("Gemini response endpoint=%s http=%s elapsed=%.1fs", endpoint, response.status, time.monotonic() - started)
        except HTTPError as exc:
            logger.info("Gemini request failed endpoint=%s http=%s", endpoint, exc.code)
            raise GeminiError(f"Gemini returned HTTP {exc.code}. Check API access, quota, and model availability; then retry.") from None
        except (URLError, TimeoutError, OSError):
            logger.info("Gemini transport failed endpoint=%s elapsed=%.1fs", endpoint, time.monotonic() - started)
            raise GeminiError("Gemini could not be reached. Please retry.") from None
        except (ValueError, UnicodeError):
            raise GeminiError("Gemini returned an invalid response. Please retry.") from None
        if not isinstance(result, dict):
            raise GeminiError("Gemini returned an unexpected response shape.")
        return result
