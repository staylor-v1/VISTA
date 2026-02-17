# Reverse Proxy Authentication: Approach Comparison

## Context

VISTA needs to support two types of API consumers through a reverse proxy:

1. **Browser users** -- authenticated via OAuth2/SAML/LDAP at the proxy layer,
   with the proxy injecting `X-User-Email` + `X-Proxy-Secret` headers.
2. **Scripts and automation** -- authenticated via `Authorization: Bearer <key>`,
   with the backend validating the API key directly.

The challenge is making both work through the same reverse proxy (nginx or
Apache) without complex configuration, and without confusing either sysadmins
or script authors.

This document evaluates four approaches and recommends one.

---

## Approach A: Single prefix with conditional OAuth (`map`/`SetEnvIf`)

**How it works:** One `/api` prefix.  The proxy detects whether the request
carries a Bearer token and conditionally skips OAuth.

```nginx
map $http_authorization $auth_request_uri {
    default       /oauth2/auth;
    "~^Bearer "   off;
}

location /api/ {
    auth_request $auth_request_uri;
    # ... inject proxy headers for OAuth, forward Authorization for Bearer ...
    proxy_pass http://backend;
}
```

**Backend impact:** None.  Single `/api` prefix, unified `get_current_user`.

### Pros

- Scripts and browsers use the same URLs (`/api/projects`).
- Backend stays simple -- one prefix, one auth function.
- No URL rewriting.

### Cons

- **Proxy config is unusual.**  `auth_request` with a variable set to `off`
  is an advanced nginx pattern that most sysadmins have not encountered.
  Apache equivalent (`SetEnvIf` + `<If>`) is similarly non-obvious.
- **Hard to debug.**  When API key requests fail, it is not clear whether
  OAuth was skipped or not.  The `map` logic is invisible in access logs.
- **Fragile.**  Some OAuth proxies (Authelia, Keycloak gatekeeper) do not
  behave well when `auth_request` is conditionally disabled.  The pattern
  has limited real-world testing outside of oauth2-proxy.

### Verdict

Clever, but pushes too much complexity to the proxy layer.  The person
configuring nginx should not need to understand VISTA's auth internals.

---

## Approach B: Single prefix with `error_page` fallback

**How it works:** One `/api` prefix.  OAuth runs on every request.  When it
returns 401 (no session cookie), the request falls through to a named location
that forwards to the backend without OAuth.

```nginx
location /api/ {
    auth_request /oauth2/auth;
    auth_request_set $user_email $upstream_http_x_auth_request_email;

    proxy_set_header X-User-Email   $user_email;
    proxy_set_header X-Proxy-Secret "SECRET";
    proxy_set_header Authorization  $http_authorization;
    proxy_pass http://backend;

    error_page 401 = @api_key_backend;
}

location @api_key_backend {
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host          $host;
    proxy_pass http://backend;
}
```

**Backend impact:** None.  Same single prefix.

### Pros

- Scripts and browsers use the same URLs.
- Backend stays simple.
- `error_page` is a well-known nginx pattern.  Most sysadmins have seen it.
- No `map` or conditional logic -- linear flow.

### Cons

- **Every API key request hits OAuth first.**  The sub-request to oauth2-proxy
  runs and returns 401 before the fallback triggers.  Typically <1ms for a
  local oauth2-proxy, but it is wasted work.
- **The 401 path is the happy path for scripts.**  This feels backwards:
  successful API key auth goes through an error handler.  Confusing when
  reading logs.
- **Duplicate proxy config.**  The `@api_key_backend` block repeats most of
  the proxy_set_header directives from the main block.
- **Harder to rate-limit separately.**  Both OAuth and API key traffic land
  in the same location block first.

### Verdict

Simple and well-understood.  A solid choice if the slight latency overhead
and "error as success" semantics are acceptable.

---

## Approach C: Multi-prefix, backend-registered (`/api`, `/api-key`)

**How it works:** The backend registers the same routers under multiple URL
prefixes (`/api`, `/api-key`, optionally `/api-ml`).  Each prefix uses a
different auth dependency.  The proxy has one location block per prefix with
no conditional logic.

```nginx
location /api/ {
    auth_request /oauth2/auth;
    # ... inject proxy headers ...
    proxy_pass http://backend;
}

location /api-key/ {
    # No auth_request.
    proxy_set_header Authorization $http_authorization;
    proxy_pass http://backend;
}
```

```python
# main.py
app.include_router(api_router, prefix="/api")       # OAuth
app.include_router(api_key_router, prefix="/api-key")  # Bearer
```

**Backend impact:** Moderate.  Routers registered multiple times.  Separate
auth dependencies per prefix.  OpenAPI schema shows duplicate endpoints.

### Pros

- **Proxy config is dead simple.**  One location block per auth method, no
  conditional logic, no error_page, no map.
- **Explicit.**  URL path makes auth method obvious.  Easy to debug.
- **Independent rate limiting.**  Each prefix gets its own `limit_req` zone.
- **No wasted work.**  API key requests never touch OAuth.

### Cons

- **Scripts must use a different URL.**  `/api-key/projects` instead of
  `/api/projects`.  This leaked backend architecture into client code.
- **Backend complexity.**  Registering routers on multiple prefixes tripled
  the OpenAPI endpoint count and created coupling between the backend and
  the proxy's URL scheme.
- **Tight coupling.**  Adding a new auth method (e.g., mTLS) required both
  backend and proxy changes.
- **This approach was already tried and removed.**  The previous
  `/api`/`/api-key`/`/api-ml` system was removed in the recent auth
  refactor due to these problems.

### Verdict

Simple proxy config, but the backend complexity and tight coupling made it
hard to maintain.  Already rejected once.

---

## Approach D: Proxy-only dual prefix with URL rewrite

**How it works:** The backend has a single `/api` prefix (no changes).  The
proxy exposes two entry points: `/api/` (OAuth) and `/ext/` (no OAuth).
Requests to `/ext/api/...` are rewritten to `/api/...` before reaching the
backend via `proxy_pass` with a path.

```nginx
# Browser users -- OAuth required
location /api/ {
    auth_request /oauth2/auth;
    auth_request_set $user_email $upstream_http_x_auth_request_email;

    proxy_set_header X-User-Email   $user_email;
    proxy_set_header X-Proxy-Secret "SECRET";
    proxy_set_header Authorization  $http_authorization;
    proxy_pass http://backend;
}

# Scripts -- no OAuth, backend validates Bearer token
location /ext/ {
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host          $host;
    proxy_pass http://backend/;   # trailing slash rewrites /ext/api/... -> /api/...
}
```

Script usage:
```bash
curl -H "Authorization: Bearer <key>" https://vista.example.com/ext/api/projects
```

**Backend impact:** None.  It only sees `/api/...` requests.

### Pros

- **Backend stays clean.**  Single `/api` prefix, unified auth, no duplicate
  router registration.  The backend has no knowledge of `/ext/`.
- **Proxy config is simple.**  Two location blocks, each with one auth method.
  No conditional logic, no error_page, no map.
- **Decoupled.**  The proxy chooses its own naming (`/ext/`, `/token/`,
  `/v1/`, whatever).  Adding a third auth method (mTLS, SAML direct) means
  adding one proxy location block -- zero backend changes.
- **Independent rate limiting.**  Separate `limit_req` zones per prefix.
- **No wasted work.**  API key requests never hit OAuth.
- **Explicit.**  The URL tells you which auth path was taken.

### Cons

- **Scripts use a different base URL.**  `/ext/api/projects` vs
  `/api/projects`.  However, the prefix is chosen by the sysadmin, not
  baked into the backend, so it can be whatever makes sense for the org.
- **URL rewriting adds a small cognitive load.**  The sysadmin needs to
  understand that `proxy_pass http://backend/;` (with trailing slash) strips
  the `/ext` prefix.  This is a standard nginx pattern but requires a note
  in the docs.
- **Apache equivalent is slightly more verbose.**  Requires `ProxyPass` with
  path mapping, but still straightforward.

### Verdict

Best balance of simplicity across all layers.  Backend stays untouched, proxy
config is easy to understand, and the URL contract is clear.

---

## Comparison Matrix

| Criterion | A: map | B: error_page | C: multi-prefix | D: proxy rewrite |
|---|---|---|---|---|
| Proxy config complexity | High | Medium | Low | Low |
| Backend changes needed | None | None | Moderate | None |
| Same URL for all clients | Yes | Yes | No | No |
| OAuth overhead for API keys | None | Yes (~1ms) | None | None |
| Rate limit separation | No | No | Yes | Yes |
| Debuggability | Poor | Fair | Good | Good |
| Sysadmin familiarity | Low | High | High | High |
| Coupling (proxy <-> backend) | Low | Low | High | None |
| Adding new auth methods | Proxy change | Proxy change | Both | Proxy only |
| Previously tried in VISTA | No | No | Yes (removed) | No |

---

## Recommendation: Approach D (proxy-only dual prefix with URL rewrite)

Approach D is recommended for the following reasons:

1. **Clean separation of concerns.**  The backend handles authentication
   logic.  The proxy handles routing and OAuth.  Neither needs to know the
   other's details.

2. **No backend changes required.**  The current unified `get_current_user`
   in `dependencies.py` already handles both Bearer tokens and proxy headers
   correctly.  There is nothing to change.

3. **Simple proxy config.**  Two location blocks, each doing one thing.  No
   advanced patterns.  A sysadmin who has never seen VISTA can read the
   config and understand it.

4. **Future-proof.**  If the org later needs mTLS for service-to-service
   calls, or SAML direct federation, or a webhook callback path, the
   sysadmin adds one location block with `proxy_pass http://backend/;`.
   The backend does not change.

5. **The "different URL" downside is minimal.**  Scripts already need to
   know the base URL.  Changing from `https://vista.example.com/api/projects`
   to `https://vista.example.com/ext/api/projects` is a one-line config
   change.  And the prefix name is the sysadmin's choice.

### Suggested naming

The proxy-side prefix should be short and self-documenting.  Options:

- `/ext/` -- "external" (non-browser) access
- `/token/` -- token-based access
- `/key/` -- API key access

`/ext/` is recommended because it is generic enough to cover future auth
methods beyond API keys.

### Implementation effort

- Update `docs/production/proxy-setup.md` to make Approach D the primary
  reverse proxy configuration.
- Update `docs/production/nginx-example.conf` with `/api/` + `/ext/` location
  blocks implementing Approach D.
- Create `docs/production/apache-example.conf` with equivalent `<Location>`
  blocks for Approach D.
- No backend code changes, no migrations, no database changes, no test changes.
