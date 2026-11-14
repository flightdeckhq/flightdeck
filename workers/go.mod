module github.com/flightdeckhq/flightdeck/workers

go 1.27.4

// The storage module lives in this repository; the services build
// against the checkout, not a published version.
replace github.com/flightdeckhq/flightdeck/storage => ../storage

require (
	github.com/flightdeckhq/flightdeck/storage v0.0.0
	github.com/jackc/pgx/v5 v5.12.0
	github.com/nats-io/nats-server/v2 v2.15.2
	github.com/nats-io/nats.go v1.55.0
)

require (
	github.com/antithesishq/antithesis-sdk-go v0.8.0-default-no-op // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/golang-migrate/migrate/v4 v4.20.1 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgerrcode v0.0.0-20220416144525-469b46aa5efa // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	github.com/klauspost/compress v1.20.3 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/minio/highwayhash v1.0.4 // indirect
	github.com/nats-io/jwt/v2 v2.8.2 // indirect
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/crypto v0.58.0 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	golang.org/x/time v0.16.0 // indirect
	modernc.org/libc v1.80.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
	modernc.org/sqlite v1.62.0 // indirect
)
