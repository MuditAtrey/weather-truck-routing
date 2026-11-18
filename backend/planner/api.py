from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI
from ninja.throttling import AnonRateThrottle

from . import services
from .domain.geo import LatLon
from .providers.errors import RoutingError
from .schemas import ErrorOut, PlanIn, PlanOut, ScoreIn, ScoreOut, TimezoneOut

api = NinjaAPI(
    title="Weather-aware truck routing",
    version="1.0.0",
    description="Plans three truck routes and scores them against forecast weather.",
    throttle=[AnonRateThrottle("40/m")],
)

ROUTING_MESSAGES = {
    "no_route": (422, "These places are not connected by road."),
    "not_on_road": (422, "A point is too far from any road. Pick a place on the road network."),
    "bad_input": (422, "The router rejected the truck parameters."),
    "too_far": (502, "Both routing services refused this trip."),
    "unavailable": (502, "The routing services are not responding. Try again in a minute."),
}


@api.exception_handler(services.PlanError)
def plan_error(request: HttpRequest, exc: services.PlanError) -> HttpResponse:
    return api.create_response(request, {"code": exc.code, "detail": exc.detail}, status=exc.status)


@api.exception_handler(RoutingError)
def routing_error(request: HttpRequest, exc: RoutingError) -> HttpResponse:
    status, detail = ROUTING_MESSAGES.get(exc.kind, (502, "Routing failed."))
    # Upstream bodies are logged, never forwarded to the client.
    return api.create_response(request, {"code": exc.kind, "detail": detail}, status=status)


@api.get("/health", response={200: dict[str, str]})
def health(request: HttpRequest) -> dict[str, str]:
    return {"status": "ok"}


@api.get("/timezone", response={200: TimezoneOut})
def timezone(request: HttpRequest, lat: float, lon: float) -> dict[str, str]:
    point: LatLon = (lat, lon)
    return {"timezone": services.timezone_at(point)}


@api.post("/plan", response={200: PlanOut, 422: ErrorOut, 502: ErrorOut})
async def plan(request: HttpRequest, payload: PlanIn) -> dict[str, object]:
    return await services.plan(payload)


@api.post("/score", response={200: ScoreOut, 422: ErrorOut})
def score(request: HttpRequest, payload: ScoreIn) -> dict[str, object]:
    return services.score(payload)
