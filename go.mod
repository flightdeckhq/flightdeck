module github.com/flightdeckhq/flightdeck

go 1.27.3

require (
	github.com/flightdeckhq/flightdeck/api v0.0.0
	github.com/flightdeckhq/flightdeck/ingestion v0.0.0
	github.com/flightdeckhq/flightdeck/storage v0.0.0
	github.com/flightdeckhq/flightdeck/workers v0.0.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/nats-io/nats-server/v2 v2.15.2
	github.com/nats-io/nats.go v1.54.0
	golang.org/x/crypto v0.58.0
)

require (
	github.com/KyleBanks/depth v1.2.1 // indirect
	github.com/antithesishq/antithesis-sdk-go v0.8.0-default-no-op // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/go-openapi/jsonpointer v0.19.6 // indirect
	github.com/go-openapi/jsonreference v0.20.2 // indirect
	github.com/go-openapi/spec v0.20.9 // indirect
	github.com/go-openapi/swag v0.22.3 // indirect
	github.com/golang-migrate/migrate/v4 v4.20.1 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/jackc/pgerrcode v0.0.0-20220416144525-469b46aa5efa // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/josharian/intern v1.0.0 // indirect
	github.com/klauspost/compress v1.20.3 // indirect
	github.com/mailru/easyjson v0.7.7 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/minio/highwayhash v1.0.4 // indirect
	github.com/nats-io/jwt/v2 v2.8.2 // indirect
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/sv-tools/openapi v0.4.0 // indirect
	github.com/swaggo/files/v2 v2.0.0 // indirect
	github.com/swaggo/http-swagger/v2 v2.0.2 // indirect
	github.com/swaggo/swag v1.16.6 // indirect
	github.com/swaggo/swag/v2 v2.0.0-rc6 // indirect
	go.opentelemetry.io/proto/slim/otlp v1.11.1 // indirect
	golang.org/x/mod v0.42.0 // indirect
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	golang.org/x/time v0.16.0 // indirect
	golang.org/x/tools v0.52.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.80.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
	modernc.org/sqlite v1.62.0 // indirect
)

// The service modules are versioned with this repository and never
// published on their own; the replaces let `go mod tidy` and a build
// without go.work resolve them to the checkout.
replace (
	github.com/flightdeckhq/flightdeck/api => ./api
	github.com/flightdeckhq/flightdeck/ingestion => ./ingestion
	github.com/flightdeckhq/flightdeck/storage => ./storage
	github.com/flightdeckhq/flightdeck/workers => ./workers
)
