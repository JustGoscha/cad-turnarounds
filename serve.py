#!/usr/bin/env python3
"""Dev server with caching disabled, so module edits show up on plain reload."""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
