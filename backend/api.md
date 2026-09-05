# Seahare API v2

Base URL: `http://127.0.0.1:8765`

## Service and configuration

- `GET /api/health`
- `GET /api/presets`
- `GET /api/dictionaries`
- `POST /api/dictionaries` body: `{ "name": "custom.txt", "content": "admin\nhealth\n" }`
- `DELETE /api/dictionaries/{name}` (custom dictionaries only)

`GET /api/presets` returns the built-in `quick`, `balanced`, and `careful`
strategies. A dictionary item includes `name`, `entries`, `size`, and `builtin`.

## Scans

- `GET /api/scans`
- `POST /api/scans`
- `GET /api/scans/{id}`
- `DELETE /api/scans/{id}` (completed or cancelled scans; deletes its results)
- `POST /api/scans/{id}/pause`
- `POST /api/scans/{id}/resume`
- `POST /api/scans/{id}/cancel`
- `POST /api/scans/{id}/retry`
- `GET /api/scans/{id}/summary`
- `GET /api/scans/{id}/export.csv`

Create a scan with a preset and optional overrides. Two payload modes are
supported: dictionary mode (default) and custom enumeration mode.

Dictionary mode:

```json
{
  "target": "https://example.com",
  "preset": "balanced",
  "dictionary": "common.txt",
  "threads": 24,
  "timeout": 8,
  "target_type": "api",
  "request_method": "GET",
  "request_headers": {},
  "request_body": ""
}
```

`target_type` is one of `web`, `api`, or `h5` and records the intended target
kind for result interpretation. `request_method` accepts `AUTO`, `GET`, `POST`,
`PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`. `AUTO` expands each dictionary
or enumeration value into all seven explicit methods. For `POST`, `PUT`,
`PATCH`, and `DELETE`, an empty body is generated as JSON
`{"value":"current-value"}`; a supplied body template is used instead, with
`{fuzz}` replaced by the current dictionary or enumeration value.
`request_headers` is an object of header names to values, and `request_body` is
an optional UTF-8 body. A body automatically receives
`Content-Type: application/json` when no content type header is supplied.
Results include the actual `request_method` and are unique by scan, path, and
method.

Custom enumeration mode generates path combinations from a charset instead of
reading a dictionary file. The target must contain the `{fuzz}` placeholder,
which is replaced by each combination. `min_len`/`max_len` bound the lengths
(1–6); the total combination count is capped at 500,000. Duplicate characters
in `charset` are removed automatically.

```json
{
  "target": "https://example.com/{fuzz}",
  "preset": "balanced",
  "threads": 24,
  "timeout": 8,
  "enum": { "charset": "abcd0123", "min_len": 2, "max_len": 3 }
}
```

Create response and scan detail share this shape (enum scans omit the
`dictionary` file and add `mode`, `charset`, `min_len`, `max_len`,
`placeholder`):

```json
{
  "id": "0a71...",
  "target": "https://example.com/{fuzz}",
  "dictionary": "",
  "threads": 24,
  "timeout": 8.0,
  "preset": "balanced",
  "mode": "enum",
  "charset": "abcd0123",
  "min_len": 2,
  "max_len": 3,
  "placeholder": "{fuzz}",
  "status": "running",
  "progress": 0.42,
  "requests": 120,
  "found": 7,
  "created_at": "2026-08-14T00:00:00+00:00",
  "started_at": "2026-08-14T00:00:00+00:00",
  "finished_at": null,
  "error": null
}
```

`POST /api/scans/{id}/retry` rebuilds the same job for both modes from its
stored configuration.

Create response and scan detail share this shape:

```json
{
  "id": "0a71...",
  "target": "https://example.com",
  "dictionary": "common.txt",
  "threads": 24,
  "timeout": 8.0,
  "preset": "balanced",
  "target_type": "api",
  "request_method": "POST",
  "request_headers": { "X-Test": "local" },
  "request_body": "{\"username\":\"demo\"}",
  "status": "running",
  "progress": 0.42,
  "requests": 120,
  "found": 7,
  "created_at": "2026-08-14T00:00:00+00:00",
  "started_at": "2026-08-14T00:00:00+00:00",
  "finished_at": null,
  "error": null
}
```

States are `queued`, `running`, `paused`, `cancelling`, `cancelled`,
`completed`, `failed`, and `interrupted`. On startup, unfinished database rows
become `interrupted`; the frontend can create a new equivalent task with
`POST /api/scans/{id}/retry`.

## Incremental results

```text
GET /api/scans/{id}/results
  ?status=all|interesting|redirect|sensitive|authentication|protected|accessible|server_error
  &severity=all|high|medium|low|info
  &after_id=0
  &limit=500
```

The endpoint is cursor based. Append `results`, then request again using
`next_cursor`. `limit` is capped at 500.

```json
{
  "results": [],
  "total": 0,
  "returned": 0,
  "next_cursor": 0,
  "has_more": false,
  "summary": {
    "total": 0,
    "max_id": 0,
    "severity": { "high": 0, "medium": 0, "low": 0, "info": 0 },
    "categories": {}
  }
}
```

Each result keeps the v1 fields and adds `request_method`, `severity`, `category`,
`redirect_location`, `business_code`, `business_message`, `response_preview`,
`body_hash`, and `spa_fallback`. `business_code` and `business_message` are
read from common JSON fields such as `errno`/`errmsg` or `code`/`message`.
`spa_fallback` is true when an HTML response has the same bounded body
fingerprint as the scan target baseline, which commonly indicates a single-page
application fallback rather than a real directory. Redirect responses are
recorded without following the `Location` target, keeping probes inside the
configured scan origin.

## Live events

`GET /api/scans/{id}/events?after_id=0` is an SSE stream. Each `snapshot`
event contains the current `scan`, newly discovered `results`, `cursor`,
`has_more`, and `summary`. The server closes a stream after the scan reaches a
terminal state or after 30 seconds; clients should reconnect with their latest
cursor. Regular detail/results polling remains supported as a fallback.

The scanner only performs requests to the target supplied by the user. Use it
only on systems you own or are authorized to test.
