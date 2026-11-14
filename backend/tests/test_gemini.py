"""Transport diagnostics never expose keys, prompts or provider error bodies."""
import io
import ssl
from unittest import TestCase
from unittest.mock import patch
from urllib.error import URLError

from backend.integrations.gemini import GeminiClient, GeminiError


class TransportTests(TestCase):
    def test_search_timeout_is_separate_from_other_requests(self):
        with patch.dict('os.environ', {'GEMINI_SEARCH_TIMEOUT_SECONDS': '120'}):
            client = GeminiClient(api_key='secret-key')
        for endpoint, payload, expected in (
            ('interactions', {'tools': [{'type': 'google_search'}]}, 120),
            ('interactions', {'input': 'Private brief'}, 75),
            ('decisions', {}, 75),
        ):
            with self.subTest(endpoint=endpoint, payload=payload), patch('backend.integrations.gemini.urlopen') as open_url:
                response = open_url.return_value.__enter__.return_value
                response.read.return_value = b'{}'
                client._post(endpoint, payload)
                self.assertEqual(open_url.call_args.kwargs['timeout'], expected)

    def test_timeout_connection_and_tls_are_distinct_and_private(self):
        cases = [
            (TimeoutError('secret-key private prompt'), 'timeout', True),
            (URLError(TimeoutError('secret-key')), 'timeout', True),
            (URLError(ConnectionResetError('secret-key')), 'connection', True),
            (URLError(ssl.SSLCertVerificationError('secret-key')), 'tls', False),
        ]
        for error, kind, retryable in cases:
            with self.subTest(kind=kind), patch('backend.integrations.gemini.urlopen', side_effect=error), \
                 self.assertLogs('backend.integrations.gemini', level='INFO') as logs:
                with self.assertRaises(GeminiError) as caught:
                    GeminiClient(api_key='secret-key')._post('decisions', {'input': 'private prompt'})
            self.assertEqual(caught.exception.error_kind, kind)
            self.assertEqual(caught.exception.retryable, retryable)
            output = str(caught.exception) + '\n'.join(logs.output)
            self.assertNotIn('secret-key', output)
            self.assertNotIn('private prompt', output)
            self.assertIn(f'kind={kind}', output)

    def test_invalid_timeout_configuration_is_rejected(self):
        for value in ('0', '-1', 'nan', 'inf', 'invalid', '601'):
            with self.subTest(value=value), patch.dict('os.environ', {'GEMINI_SEARCH_TIMEOUT_SECONDS': value}):
                with self.assertRaises(GeminiError):
                    GeminiClient(api_key='test-key')

    def test_http_errors_keep_status_and_do_not_log_error_body(self):
        from urllib.error import HTTPError
        error = HTTPError('https://provider.test', 429, 'secret', {'Retry-After': '2'}, io.BytesIO(b'secret'))
        with patch('backend.integrations.gemini.urlopen', side_effect=error):
            with self.assertRaises(GeminiError) as caught:
                GeminiClient(api_key='test-key')._post('decisions', {})
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.retry_after, 2)
        self.assertTrue(caught.exception.retryable)
        self.assertNotIn('secret', str(caught.exception))
