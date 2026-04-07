# Multi-stage build: compile Go binary, copy to minimal image.
FROM golang:1.24-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /workers ./cmd/

FROM alpine:3.20
RUN apk --no-cache add ca-certificates
COPY --from=builder /workers /usr/local/bin/workers
CMD ["workers"]
