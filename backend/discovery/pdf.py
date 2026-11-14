"""Isolate parsing of untrusted PDFs with CPU, memory, and parent wall-time bounds."""
import json
import resource
import sys


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    if sys.platform.startswith('linux'):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    import io
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(sys.stdin.buffer.read(4 * 1024 * 1024 + 1)))
    text = '\n'.join((page.extract_text() or '')[:30000] for page in reader.pages[:20])[:200000]
    title = str((reader.metadata or {}).get('/Title', ''))[:500]
    print(json.dumps(dict(text=text, title=title)))


if __name__ == '__main__':
    main()
