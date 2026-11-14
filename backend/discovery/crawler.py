"""Bounded public-web fetching, robots handling, and source-text extraction.

DNS answers are validated then pinned to the connection; every redirect is
validated again. No proxy environment variables, cookies, or credentials are used.
"""
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from backend.domain.contracts import Evidence, PipelineIssue

USER_AGENT = 'QuotePilotBot/1.0'
MAX_BYTES = 4 * 1024 * 1024


class CrawlError(Exception):
    pass


def canonical_url(url):
    p = urlsplit(str(url))
    if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password:
        raise CrawlError('Only public HTTP(S) URLs without credentials are allowed.')
    if p.port not in (None, 80 if p.scheme == 'http' else 443):
        raise CrawlError('Nonstandard network ports are not allowed.')
    host = p.hostname.encode('idna').decode().lower().rstrip('.')
    if ':' in host:
        host = f'[{host}]'
    return urlunsplit((p.scheme, host, p.path or '/', p.query, ''))


def hostname(url):
    host = urlsplit(str(url)).hostname
    if not host:
        raise CrawlError('URL has no hostname.')
    return host.lower().removeprefix('www.')


def public_address(host, port):
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(a[4][0] for a in answers))
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise CrawlError('Blocked a non-public network address.')
    return addresses[0]


class PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, address, port, timeout):
        super().__init__(host, port, timeout=timeout)
        self.address = address

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class PinnedHTTPS(PinnedHTTP):
    def connect(self):
        super().connect()
        self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


@dataclass
class Page:
    requested_url: str
    url: str
    title: str
    text: str
    links: list
    fetched_at: str
    content_hash: str
    kind: str
    name: str = ''
    legal_id: str = ''


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.schemas = [], [], []
        self.hidden = 0
        self.in_title = False
        self.title = ''
        self.schema = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style', 'noscript', 'svg'):
            self.hidden += 1
        if tag == 'script' and attrs.get('type') == 'application/ld+json':
            self.schema = ''
        if tag == 'title':
            self.in_title = True
        if tag == 'a' and attrs.get('href'):
            self.links.append(attrs['href'])
        if tag in ('p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'tr', 'section'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'script' and self.schema is not None:
            self.schemas.append(self.schema)
            self.schema = None
        if tag in ('script', 'style', 'noscript', 'svg'):
            self.hidden = max(0, self.hidden - 1)
        if tag == 'title':
            self.in_title = False
        if tag in ('p', 'div', 'li', 'h1', 'h2', 'h3', 'tr', 'section'):
            self.parts.append('\n')

    def handle_data(self, data):
        if self.schema is not None:
            self.schema += data
        if self.in_title:
            self.title += data
        elif not self.hidden:
            self.parts.append(data)


def organization(schemas, url):
    """Use same-site Organization metadata only; never merge companies by name."""
    def nodes(value):
        if isinstance(value, list):
            for item in value:
                yield from nodes(item)
        elif isinstance(value, dict):
            yield value
            yield from nodes(value.get('@graph', []))
    for raw in schemas:
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        for node in nodes(data):
            types = node.get('@type', [])
            types = [types] if isinstance(types, str) else types
            if not isinstance(types, list) or not set(map(str, types)) & {'Organization', 'Corporation', 'LocalBusiness'}:
                continue
            site = node.get('url')
            try:
                if not isinstance(site, str) or hostname(canonical_url(urljoin(url, site))) != hostname(url):
                    continue
            except (ValueError, CrawlError):
                continue
            name = node.get('legalName') or node.get('name')
            vat = node.get('vatID')
            # Country-prefixed VAT identifiers avoid collisions across jurisdictions.
            legal_id = re.sub(r'[^A-Z0-9]', '', vat.upper()) if isinstance(vat, str) else ''
            if not re.fullmatch(r'[A-Z]{2}[A-Z0-9]{5,18}', legal_id):
                legal_id = ''
            return (name[:300] if isinstance(name, str) else ''), legal_id
    return '', ''


def parse_page(requested, url, body, content_type):
    kind, name, legal_id, links, title = 'page', '', '', [], ''
    if 'application/pdf' in content_type or body.startswith(b'%PDF-'):
        try:
            process = subprocess.run([sys.executable, '-m', 'backend.discovery.pdf'], input=body,
                                     capture_output=True, timeout=15, check=True)
            document = json.loads(process.stdout)
            text, title = document['text'], document['title']
        except (subprocess.SubprocessError, ValueError, KeyError) as exc:
            raise CrawlError('Could not extract PDF text within resource limits.') from exc
        kind = 'pdf'
    elif 'html' in content_type:
        charset = re.search(r'charset=["\']?([\w-]+)', content_type)
        try:
            decoded = body.decode(charset.group(1) if charset else 'utf-8', errors='replace')
        except LookupError:
            decoded = body.decode('utf-8', errors='replace')
        parser = PageParser()
        parser.feed(decoded)
        text = '\n'.join(' '.join(line.split()) for line in ''.join(parser.parts).splitlines() if line.strip())
        title, links = parser.title.strip()[:500], parser.links
        name, legal_id = organization(parser.schemas, url)
    elif 'text/plain' in content_type:
        text = body.decode('utf-8', errors='replace')
    else:
        raise CrawlError('Unsupported document type; expected HTML, text, or PDF.')
    if not text.strip():
        raise CrawlError('No readable text found; the page may require JavaScript or OCR.')
    return Page(requested, url, title, text[:200000], links[:1000], datetime.now(timezone.utc).isoformat(),
                hashlib.sha256(body).hexdigest(), kind, name, legal_id)


class Crawler:
    def __init__(self, store, refresh=False):
        self.store, self.refresh = store, refresh
        self._guard = threading.Lock()
        self._locks, self._last, self._robots = {}, {}, {}

    def _once(self, url):
        parsed = urlsplit(url)
        port = 443 if parsed.scheme == 'https' else 80
        address = public_address(parsed.hostname, port)
        with self._guard:
            lock = self._locks.setdefault(parsed.hostname, threading.Lock())
        with lock:
            delay = max(.5, self._robots.get(parsed.netloc, (None, .5))[1])
            time.sleep(max(0, delay - (time.monotonic() - self._last.get(parsed.hostname, 0))))
            connection = (PinnedHTTPS if parsed.scheme == 'https' else PinnedHTTP)(parsed.hostname, address, port, 8)
            try:
                connection.request('GET', urlunsplit(('', '', parsed.path or '/', parsed.query, '')),
                                   headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity'})
                response = connection.getresponse()
                headers = dict((k.lower(), v) for k, v in response.getheaders())
                if int(headers.get('content-length', '0')) > MAX_BYTES:
                    raise CrawlError('Page exceeds the 4 MB download limit.')
                # One read can otherwise keep a thread alive on a slow trickle.
                chunks, size, started = [], 0, time.monotonic()
                while True:
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_BYTES or time.monotonic() - started > 15:
                        raise CrawlError('Page exceeded the download size or time limit.')
                return response.status, headers, b''.join(chunks)
            finally:
                connection.close()
                self._last[parsed.hostname] = time.monotonic()

    def _download(self, url, robots=False):
        for _ in range(6):
            url = canonical_url(url)
            if not robots:
                self._check_robots(url)
            status, headers, body = self._once(url)
            if status in (301, 302, 303, 307, 308):
                target = headers.get('location')
                if not target:
                    raise CrawlError('Redirect had no destination.')
                url = urljoin(url, target)
                continue
            return url, status, headers, body
        raise CrawlError('Too many redirects.')

    def _check_robots(self, url):
        p = urlsplit(url)
        origin = f'{p.scheme}://{p.netloc}'
        if origin not in self._robots:
            _, status, _, body = self._download(origin + '/robots.txt', robots=True)
            parser = RobotFileParser()
            if status in (404, 410):
                parser.parse([])
            elif status == 200:
                parser.parse(body.decode('utf-8', errors='replace').splitlines())
            else:
                raise CrawlError(f'robots.txt unavailable (HTTP {status}); deferred crawling.')
            delay = parser.crawl_delay(USER_AGENT) or parser.crawl_delay('*') or .5
            if delay > 30:
                raise CrawlError('Site requests a crawl delay beyond this research budget.')
            self._robots[origin] = (parser, delay)
            self._robots[p.netloc] = (parser, delay)
        if not self._robots[origin][0].can_fetch(USER_AGENT, url):
            raise CrawlError('Page disallowed by robots.txt.')

    def fetch(self, url):
        requested = canonical_url(url)
        cache_key = 'page:' + requested
        cached = None if self.refresh else self.store.cached(cache_key)
        if cached:
            return Page(**cached)
        final, status, headers, body = self._download(requested)
        if status != 200:
            raise CrawlError(f'Source returned HTTP {status}.')
        if headers.get('content-encoding', 'identity') not in ('identity', ''):
            raise CrawlError('Unsupported compressed response.')
        page = parse_page(requested, final, body, headers.get('content-type', ''))
        self.store.cache(cache_key, asdict(page))
        return page


def relevant_excerpt(text, requirements, limit=6000):
    """Select a contiguous source passage, never synthesize or join claims."""
    terms = set(re.findall(r'\w{3,}', (requirements.product + ' ' +
                ' '.join(c.description for c in requirements.criteria)).lower()))
    starts = [*range(0, max(1, len(text) - limit + 1), 1500), max(0, len(text) - limit)]
    start = max(starts, key=lambda i: sum(text[i:i+limit].lower().count(t) for t in terms))
    return text[start:start + limit]


def crawl_supplier(crawler, supplier, requirements, options):
    queue = [(str(url), 0) for url in supplier.source_urls]
    queue.append((str(supplier.website), 0))
    seen, hashes, issues = set(), set(), []
    allowed = {hostname(supplier.website)}
    started = time.monotonic()
    attempts = 0
    while queue and attempts < options.max_pages_per_supplier and time.monotonic() - started < 90:
        url, depth = queue.pop(0)
        try:
            url = canonical_url(url)
            if url in seen or hostname(url) not in allowed:
                continue
            seen.add(url)
            attempts += 1
            page = crawler.fetch(url)
            # A successful redirect from the cited site is an observed alias.
            allowed.add(hostname(page.url))
            supplier.aliases = sorted(set(supplier.aliases) | allowed)
            if page.name:
                supplier.name = page.name
                supplier.identity_status = 'site_identified'
            if page.legal_id:
                supplier.legal_id = page.legal_id
            if page.content_hash not in hashes:
                hashes.add(page.content_hash)
                supplier.evidence.append(Evidence(
                    id=hashlib.sha256((page.url + page.content_hash).encode()).hexdigest()[:24],
                    source_url=page.url, requested_url=url, excerpt=relevant_excerpt(page.text, requirements),
                    fetched_at=page.fetched_at, title=page.title, content_hash=page.content_hash, kind=page.kind))
            if depth < options.max_depth:
                links = []
                for link in page.links:
                    try:
                        target = canonical_url(urljoin(page.url, link))
                        if hostname(target) in allowed and target not in seen:
                            links.append(target)
                    except (ValueError, CrawlError):
                        continue
                terms = re.findall(r'\w{3,}', requirements.product.lower()) + [
                    'product', 'capabilit', 'certif', 'quality', 'sustainab', 'esg', 'environ',
                    'iso14001', 'iso-14001', 'carbon', 'about', 'contact', 'deliver', '.pdf']
                links = sorted(set(links), key=lambda u: (-sum(t in u.lower() for t in terms), u))
                queue.extend((link, depth + 1) for link in links[:30])
        except (CrawlError, OSError, ValueError, http.client.HTTPException) as exc:
            issues.append(PipelineIssue(stage='discovery', supplier_id=supplier.supplier_id,
                                        code='crawl_unavailable', message=str(exc)[:300], url=url, retryable=True))
    supplier.crawl_status = ('partial' if issues or queue else 'complete') if supplier.evidence else 'unavailable'
    return supplier, issues
