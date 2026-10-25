# Multi-stage build: compile Go binary, copy to minimal image.
FROM golang:1.27.3-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /api ./cmd/

FROM alpine:3.24
RUN apk --no-cache add ca-certificates wget
COPY --from=builder /api /usr/local/bin/api
# Bake pricing.yaml, the price overrides layered over the catalogue the
# binary embeds, into the image. Operators who want their own prices
# without rebuilding can either mount a replacement file at
# /etc/flightdeck/pricing.yaml or set FLIGHTDECK_PRICING_PATH to a
# different location. See CONTRIBUTING.md ("Updating pricing data").
COPY pricing.yaml /etc/flightdeck/pricing.yaml
RUN addgroup -S flightdeck && adduser -S flightdeck -G flightdeck
USER flightdeck
EXPOSE 8081
CMD ["api"]
