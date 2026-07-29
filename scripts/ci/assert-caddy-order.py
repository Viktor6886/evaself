import json, sys

config = json.load(open(sys.argv[1]))
PUBLIC = {"example.test", "app.example.test", "api.example.test"}
failures = []


def flatten(routes, acc):
    """Handlers in the order Caddy will evaluate them."""
    for route in routes:
        paths = [p for m in route.get("match", [{}]) for p in m.get("path", [])]
        for handler in route.get("handle", []):
            acc.append((tuple(paths), handler.get("handler")))
            if handler.get("handler") == "subroute":
                flatten(handler.get("routes", []), acc)
    return acc


def check(scope, label):
    """Inside this scope the /v1 deny must come before any reverse_proxy."""
    flat = flatten(scope, [])
    deny = next(
        (i for i, (paths, name) in enumerate(flat) if "/v1/*" in paths and name == "subroute"),
        None,
    )
    proxy = next((i for i, (_, name) in enumerate(flat) if name == "reverse_proxy"), None)
    if deny is None:
        failures.append(f"{label}: no /v1/* deny in this scope")
    elif proxy is not None and proxy < deny:
        failures.append(f"{label}: reverse_proxy is reached before the /v1 deny")


for route in config["apps"]["http"]["servers"]["srv0"]["routes"]:
    hosts = [h for m in route.get("match", []) for h in m.get("host", [])]
    if not hosts or hosts[0] not in PUBLIC:
        continue
    host = hosts[0]
    top = route["handle"][0]["routes"]

    # /admin-api/* is the console's own authenticated path to /v1 — exempt.
    api_scopes = [
        handler.get("routes", [])
        for entry in top
        for handler in entry.get("handle", [])
        if handler.get("handler") == "subroute"
        and any("/api/*" in m.get("path", []) for m in entry.get("match", [{}]))
    ]
    if api_scopes:
        for index, scope in enumerate(api_scopes):
            check(scope, f"{host} /api/* [{index}]")
    else:
        check(
            [
                entry
                for entry in top
                if not any("/admin-api/*" in m.get("path", []) for m in entry.get("match", [{}]))
            ],
            host,
        )

if failures:
    print("::error::the administrative surface is not actually blocked:")
    for item in failures:
        print(f"  {item}")
    sys.exit(1)
print("the /v1 deny precedes the proxy on every public host")
