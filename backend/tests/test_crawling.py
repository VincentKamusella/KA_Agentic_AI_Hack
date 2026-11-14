import io
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from unittest.mock import patch

from backend.discovery.crawler import Crawler, CrawlError, canonical_url, parse_page, public_address
from backend.tests.base import StoreCase


class FetchTests(StoreCase):
    def test_private_mixed_and_mapped_dns_answers_blocked(self):
        for addresses in [['127.0.0.1'], ['::1'], ['169.254.169.254'], ['::ffff:127.0.0.1'],
                          ['93.184.216.34', '10.0.0.2']]:
            with self.subTest(addresses=addresses), patch('socket.getaddrinfo', return_value=[
                    (socket.AF_INET, socket.SOCK_STREAM, 6, '', (a, 443)) for a in addresses]):
                with self.assertRaises(CrawlError):
                    public_address('supplier.test', 443)

    def test_public_address_is_pinned(self):
        from backend.discovery.crawler import PinnedHTTP
        with patch('socket.create_connection') as connect:
            PinnedHTTP('supplier.test', '93.184.216.34', 80, 8).connect()
            connect.assert_called_once_with(('93.184.216.34', 80), 8)

    def test_credentials_ports_and_non_http_rejected(self):
        for url in ['file:///etc/passwd', 'https://user:pass@host.test/', 'http://host.test:8080/']:
            with self.assertRaises(CrawlError):
                canonical_url(url)

    def test_redirect_to_private_address_blocked_before_connection(self):
        crawler = Crawler(self.store)
        with patch.object(crawler, '_check_robots'), patch('backend.discovery.crawler.public_address',
                side_effect=['93.184.216.34', CrawlError('private')]), patch('backend.discovery.crawler.PinnedHTTPS') as conn:
            resp = conn.return_value.getresponse.return_value
            resp.status = 302
            resp.getheaders.return_value = [('location', 'https://127.0.0.1/private')]
            resp.read1.return_value = b''
            with self.assertRaises(CrawlError):
                crawler.fetch('https://supplier.test/')
            self.assertEqual(conn.call_count, 1)

    def test_robots_disallow_and_failed_robots_never_fetch_page(self):
        for status, body in [(200, b'User-agent: *\nDisallow: /private'), (503, b'')]:
            crawler = Crawler(self.store)
            with patch.object(crawler, '_once', return_value=(status, {}, body)) as get:
                with self.assertRaises(CrawlError):
                    crawler.fetch('https://supplier.test/private')
                self.assertEqual(get.call_count, 1)
                self.assertTrue(get.call_args.args[0].endswith('/robots.txt'))

    def test_page_cache_keeps_original_timestamp_and_skips_network(self):
        crawler = Crawler(self.store)
        with patch.object(crawler, '_download', return_value=('https://supplier.test/', 200,
                          {'content-type': 'text/html'}, b'<h1>Steel bolts</h1>')) as get:
            first = crawler.fetch('https://supplier.test/')
            second = crawler.fetch('https://supplier.test/')
            self.assertEqual(first.fetched_at, second.fetched_at)
            self.assertEqual(get.call_count, 1)
            Crawler(self.store, refresh=True)  # Refresh behavior is exercised below.
        with patch.object(Crawler, '_download', return_value=('https://supplier.test/', 200,
                          {'content-type': 'text/html'}, b'<h1>Updated bolts</h1>')) as get:
            refreshed = Crawler(self.store, refresh=True).fetch('https://supplier.test/')
            self.assertNotEqual(first.content_hash, refreshed.content_hash)
            get.assert_called_once()

    def test_actual_text_metadata_and_scripts_removed(self):
        page = parse_page('https://maker.test/', 'https://maker.test/', b'''
          <title>Products</title><script>Fabricated instruction</script><style>hidden</style>
          <script type="application/ld+json">{"@type":"Organization","url":"https://maker.test",
          "legalName":"Bolt Works GmbH","vatID":"DE123456789"}</script>
          <h1>Precision steel bolts</h1><p>ISO 9001 certified.</p><a href="/quality">Quality</a>
        ''', 'text/html')
        self.assertNotIn('Fabricated', page.text)
        self.assertNotIn('legalName', page.text)
        self.assertEqual(page.name, 'Bolt Works GmbH')
        self.assertEqual(page.legal_id, 'DE123456789')
        self.assertIn('ISO 9001 certified.', page.text)
        self.assertEqual(page.links, ['/quality'])

    def test_pdf_extraction_in_bounded_subprocess(self):
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter()
        page = writer.add_blank_page(500, 500)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 20 20 Td (Precision bolts ISO 9001) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        buffer = io.BytesIO()
        writer.write(buffer)
        # Extraction runs in crawler threads. On macOS it must not fork after
        # native networking frameworks have initialized in the parent.
        no_fork = (patch('subprocess._fork_exec', side_effect=AssertionError('Unsafe threaded fork'))
                   if sys.platform == 'darwin' else nullcontext())
        with no_fork, ThreadPoolExecutor(max_workers=1) as pool:
            extracted = pool.submit(parse_page, 'https://maker.test/spec.pdf',
                                    'https://maker.test/spec.pdf', buffer.getvalue(), 'application/pdf').result()
        self.assertEqual(extracted.kind, 'pdf')
        self.assertIn('Precision bolts ISO 9001', extracted.text)
