// Package docs exposes the generated swagger.json as embedded bytes
// so the http server can serve a static spec at /docs/swagger.json
// instead of relying on httpSwagger's dynamic ``doc.json`` endpoint,
// which 500s under the swag/v2 v2.0.0-rc5 + http-swagger v2.0.2
// runtime combination this project pins.
//
// This file is hand-written and survives ``swag init`` regeneration
// (which only rewrites docs.go, swagger.json, and swagger.yaml).
package docs

import _ "embed"

// SwaggerJSON is the embedded contents of ``ingestion/docs/swagger.json``
// at build time. Served verbatim by the ingestion server's static
// ``GET /docs/swagger.json`` handler. Re-run ``swag init`` to refresh.
//
//go:embed swagger.json
var SwaggerJSON []byte
