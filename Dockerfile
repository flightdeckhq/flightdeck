# syntax=docker/dockerfile:1
#
# The all-in-one image, flightdeckhq/flightdeck: the `flightdeck` binary
# (ingestion, workers, query API, embedded NATS and the dashboard in one
# process) on a distroless base, as a non-root user.
#
#   docker run -d --name flightdeck -p 4000:4000 -v flightdeck-data:/data \
#     -e FLIGHTDECK_DATABASE_URL='postgres://user:password@host:5432/flightdeck?sslmode=disable' \
#     flightdeckhq/flightdeck
#   docker logs flightdeck     # the start-up block with the dashboard token
#
# :4000 inside the container is not a loopback address, so the binary
# mints an access token on its first start, prints it in the start-up
# block (docker logs) and keeps it in /data/secrets.json for the next
# starts. Everything the container writes lives under /data.
#
# The release workflow builds this file for linux/amd64 and linux/arm64
# with buildx; the Go cross-compile runs on the build platform, so no
# emulation is needed. Build locally with
#   docker build --build-arg VERSION=v$(cat VERSION) -t flightdeck .

# ---- dashboard bundle -----------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-alpine AS webui
WORKDIR /src/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
# Source maps are 12 MB the browser never asks for in production.
RUN npm run build && find dist -name '*.map' -delete

# ---- binary ---------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS build
ARG TARGETOS
ARG TARGETARCH
# What `flightdeck --version` prints; release.yml passes the tag.
ARG VERSION=dev
WORKDIR /src
COPY . .
COPY --from=webui /src/dashboard/dist ./webui/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/flightdeck ./cmd/flightdeck
# The data dir, owned by the runtime user (distroless has no shell to
# create it at start). 65532 is distroless's nonroot uid.
RUN mkdir -p /out/data && chown 65532:65532 /out/data

# ---- runtime --------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/flightdeck /usr/local/bin/flightdeck
COPY --from=build --chown=nonroot:nonroot /out/data /data
# The operator's price overrides, where the query API looks for them.
COPY pricing.yaml /etc/flightdeck/pricing.yaml
VOLUME /data
EXPOSE 4000
USER nonroot
ENTRYPOINT ["/usr/local/bin/flightdeck", "--data-dir", "/data", "--listen", ":4000"]
