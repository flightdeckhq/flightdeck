# Multi-stage build: compile Go binary, copy to minimal image.
# Built from the repository root (docker build -f ingestion/Dockerfile .):
# ingestion/go.mod replaces the storage module with ../storage, so both
# modules must be in the build context.
FROM golang:1.27.3-alpine AS builder

WORKDIR /build
COPY storage/go.mod storage/go.sum ./storage/
COPY ingestion/go.mod ingestion/go.sum ./ingestion/
RUN cd ingestion && go mod download
COPY storage/ ./storage/
COPY ingestion/ ./ingestion/
RUN cd ingestion && CGO_ENABLED=0 GOOS=linux go build -o /ingestion ./cmd/

FROM alpine:3.24
RUN apk --no-cache add ca-certificates wget
COPY --from=builder /ingestion /usr/local/bin/ingestion
RUN addgroup -S flightdeck && adduser -S flightdeck -G flightdeck
USER flightdeck
EXPOSE 8080
CMD ["ingestion"]
