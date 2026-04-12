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
EXPOSE 8081
CMD ["api"]
