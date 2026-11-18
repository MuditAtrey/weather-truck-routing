"""Shared HTTP client and a polite per-host request gate.

An httpx.AsyncClient is bound to the event loop it was created on. Django's dev server
runs each async request on a fresh loop, so one module-level client breaks there
("Event loop is closed"). Keeping one client per loop works under runserver, uvicorn
and Vercel alike.
"""

import asyncio
import time
import weakref

import httpx
from django.conf import settings

_clients: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = (
    weakref.WeakKeyDictionary()
)

TIMEOUT = httpx.Timeout(connect=1.5, read=8.0, write=5.0, pool=2.0)


def client() -> httpx.AsyncClient:
    loop = asyncio.get_running_loop()
    c = _clients.get(loop)
    if c is None or c.is_closed:
        c = httpx.AsyncClient(
            timeout=TIMEOUT,
            headers={"User-Agent": settings.USER_AGENT, "Referer": settings.APP_URL},
            transport=httpx.AsyncHTTPTransport(
                retries=1, limits=httpx.Limits(max_connections=4, max_keepalive_connections=2)
            ),
        )
        _clients[loop] = c
    return c


class HostGate:
    """At most one request per `interval` seconds to one host, as the free servers ask."""

    def __init__(self, interval: float = 1.0) -> None:
        self.interval = interval
        self._next = 0.0
        self._locks: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = (
            weakref.WeakKeyDictionary()
        )

    async def wait(self) -> None:
        loop = asyncio.get_running_loop()
        lock = self._locks.setdefault(loop, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            if now < self._next:
                await asyncio.sleep(self._next - now)
            self._next = time.monotonic() + self.interval
