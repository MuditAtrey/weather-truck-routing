class RoutingError(Exception):
    """A routing request failed. `kind` tells the caller what to do about it.

    - "no_route": the places are not connected by road (island, ocean). Do not retry.
    - "not_on_road": a point is too far from any road. Do not retry.
    - "too_far": over the provider's distance limit. Try another provider.
    - "unavailable": timeout, 5xx, connection error. Try another provider.
    """

    def __init__(self, kind: str, provider: str, detail: str = "") -> None:
        super().__init__(f"{provider}: {kind} {detail}".strip())
        self.kind = kind
        self.provider = provider
        self.detail = detail

    @property
    def retryable(self) -> bool:
        return self.kind in {"too_far", "unavailable"}
