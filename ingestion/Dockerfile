# Multi-stage build: compile Go binary, copy to minimal image.
FROM golang:1.26.2-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /ingestion ./cmd/

FROM alpine:3.20
RUN apk --no-cache add ca-certificates wget
COPY --from=builder /ingestion /usr/local/bin/ingestion
EXPOSE 8080
CMD ["ingestion"]
