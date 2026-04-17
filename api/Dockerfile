# Multi-stage build: compile Go binary, copy to minimal image.
FROM golang:1.26.2-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /api ./cmd/

FROM alpine:3.20
RUN apk --no-cache add ca-certificates wget
COPY --from=builder /api /usr/local/bin/api
# Bake pricing.yaml into the image so a production deployment ships
# with a working cost-estimation table out of the box. Operators who
# want to override list prices without rebuilding can either mount a
# replacement file at /etc/flightdeck/pricing.yaml or set
# FLIGHTDECK_PRICING_PATH to a different location. See DECISIONS.md
# D102 and CONTRIBUTING.md ("Updating pricing data").
COPY pricing.yaml /etc/flightdeck/pricing.yaml
EXPOSE 8081
CMD ["api"]
