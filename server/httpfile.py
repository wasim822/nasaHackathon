"""Seekable, read-only file object over HTTP range requests (Earthdata-authenticated).

ASF answers an authenticated request with a redirect to a short-lived signed CloudFront
URL; we resolve that once and then issue byte-range GETs against it. Blocks are cached so
h5py's many small metadata reads don't each become a network round-trip.
"""
from __future__ import annotations

import io
import os
import threading

import requests

BLOCK = 4 * 1024 * 1024  # 4 MiB


def earthdata_token() -> str:
    tok = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not tok:
        raise RuntimeError("EARTHDATA_TOKEN is not set (see .env.local)")
    return tok


class HttpRangeFile(io.RawIOBase):
    def __init__(self, url: str, token: str, session: requests.Session | None = None):
        super().__init__()
        self.session = session or requests.Session()
        r = self.session.get(url, headers={"Authorization": f"Bearer {token}"}, allow_redirects=False, timeout=60)
        if r.status_code in (301, 302, 303, 307, 308):
            self.url = r.headers["Location"]
        elif r.status_code == 200:
            self.url = url
            r.close()
        else:
            raise RuntimeError(f"Earthdata download refused (HTTP {r.status_code}): {r.text[:200]}")
        h = self.session.get(self.url, headers={"Range": "bytes=0-0"}, timeout=60)
        if h.status_code != 206:
            raise RuntimeError(f"Server does not support range reads (HTTP {h.status_code})")
        self.size = int(h.headers["Content-Range"].split("/")[-1])
        self.pos = 0
        self.blocks: dict[int, bytes] = {}
        self.bytes_fetched = 0
        self.lock = threading.Lock()

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            self.pos = offset
        elif whence == 1:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def _block(self, i: int) -> bytes:
        with self.lock:
            b = self.blocks.get(i)
        if b is not None:
            return b
        start = i * BLOCK
        end = min(self.size, start + BLOCK) - 1
        r = self.session.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=120)
        r.raise_for_status()
        b = r.content
        with self.lock:
            self.blocks[i] = b
            self.bytes_fetched += len(b)
        return b

    def readinto(self, buf) -> int:  # type: ignore[override]
        n = len(buf)
        if self.pos >= self.size or n == 0:
            return 0
        n = min(n, self.size - self.pos)
        out = memoryview(buf)
        done = 0
        while done < n:
            i, off = divmod(self.pos + done, BLOCK)
            b = self._block(i)
            take = min(len(b) - off, n - done)
            out[done : done + take] = b[off : off + take]
            done += take
        self.pos += n
        return n
