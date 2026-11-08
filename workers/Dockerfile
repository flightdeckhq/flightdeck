# Multi-stage build: compile Go binary, copy to minimal image.
# Built from the repository root (docker build -f workers/Dockerfile .):
# workers/go.mod replaces the storage module with ../storage, so both
# modules must be in the build context.
FROM golang:1.27.3-alpine AS builder

WORKDIR /build
COPY storage/go.mod storage/go.sum ./storage/
COPY workers/go.mod workers/go.sum ./workers/
RUN cd workers && go mod download
COPY storage/ ./storage/
COPY workers/ ./workers/
RUN cd workers && CGO_ENABLED=0 GOOS=linux go build -o /workers ./cmd/

FROM alpine:3.24
RUN apk --no-cache add ca-certificates
COPY --from=builder /workers /usr/local/bin/workers
RUN addgroup -S flightdeck && adduser -S flightdeck -G flightdeck
USER flightdeck
CMD ["workers"]
