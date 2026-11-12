# syntax=docker/dockerfile:1
#
# The all-in-one image, flightdeckhq/flightdeck: the `flightdeck` binary
# (ingestion, workers, query API, embedded NATS and the dashboard in one
# process) on a distroless base, as a non-root user.
#
#   docker run -p 127.0.0.1:4000:4000 -v flightdeck:/data flightdeckhq/flightdeck
#
# That is the whole install: nothing else to start or configure. The
# start-up block it prints carries the dashboard URL and the token; with
# `-d --name flightdeck` it is in `docker logs flightdeck`.
#
# Data. Everything the container writes lives under /data: the database
# (a SQLite file, /data/flightdeck.db), the message-bus store and
# secrets.json. The volume keeps it across `docker rm` and an image
# update; without `-v` Docker gives each container an anonymous volume
# of its own and a new container starts empty. /data is 0700 and owned
# by the runtime user (uid 65532), and a new named volume takes that
# over. A bind mount (`-v /srv/flightdeck:/data`) keeps the host
# directory's owner and mode: make it writable by uid 65532 and 0700,
# or the binary warns that the directory is readable by others. One
# container per volume: a second one on the same /data is refused. The
# root filesystem is never written, so `--read-only` works as is.
#
# Postgres instead of SQLite: add
#   -e FLIGHTDECK_DATABASE_URL='postgres://user:password@host:5432/flightdeck?sslmode=disable'
# The schema is created on the first start; /data then holds only the
# bus store and secrets.json, and is still worth a volume.
#
# Configuration. The image sets the binary's data dir and listen
# address in the environment (FLIGHTDECK_DATA_DIR=/data,
# FLIGHTDECK_LISTEN=:4000), not as flags, so the health check below,
# `docker exec <container> flightdeck health` and a Kubernetes exec
# probe read the same values as the server. Change either with `-e`;
# a flag after the image name still wins for the server, but the
# health check does not see it.
#
# Publish the port on 127.0.0.1 (as above) unless other machines should
# reach it: the dashboard token is served to anyone who can reach the
# origin. :4000 inside the container is not a loopback address, so the
# binary mints an access token on its first start, prints it once in the
# start-up block (treat the container's logs as the secret they carry)
# and keeps it in /data/secrets.json, mode 0600, for the next starts.
# The base images are pinned by digest; Dependabot proposes the updates.
#
# The release workflow builds this file for linux/amd64 and linux/arm64
# with buildx; the Go cross-compile runs on the build platform, so no
# emulation is needed. Build locally with
#   docker build --build-arg VERSION=v$(cat VERSION) -t flightdeck .

# ---- dashboard bundle -----------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS webui
WORKDIR /src/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
# Source maps are 12 MB the browser never asks for in production.
RUN npm run build && find dist -name '*.map' -delete

# ---- binary ---------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
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
# An empty directory for the runtime stage to copy as /data: distroless
# has no shell to create one, and none to chmod it at start.
RUN mkdir /out/data

# ---- runtime --------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/flightdeck /usr/local/bin/flightdeck
# The data dir, 0700 and owned by the runtime user (65532 is
# distroless's nonroot uid), which is what the binary expects of the
# directory that holds its database and secrets. --chmod sets it: COPY
# creates the destination 0755 whatever the source's mode. A new named
# volume mounted here is initialised with this owner and mode.
COPY --from=build --chown=65532:65532 --chmod=700 /out/data /data
# The operator's price overrides, where the query API looks for them.
COPY pricing.yaml /etc/flightdeck/pricing.yaml
VOLUME /data
EXPOSE 4000
USER nonroot
ENV FLIGHTDECK_DATA_DIR=/data \
    FLIGHTDECK_LISTEN=:4000
# `flightdeck health` asks the instance in this container whether its
# query API and its ingestion API answer, and exits 0 or 1. The image
# has no shell and no curl, so the binary is its own probe; exec form,
# for the same reason. The values:
#   interval 10s      how soon a wedged instance shows as unhealthy; a
#                     check is one process start and two requests on
#                     loopback.
#   timeout 5s        above the three seconds the command gives itself,
#                     so it reports why it failed and is not killed
#                     mid-probe.
#   start-period 60s  the binary waits up to a minute for a database
#                     that is still starting and then migrates it;
#                     failures in that window do not count.
#   retries 3         one slow answer does not mark the container.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/flightdeck", "health"]
ENTRYPOINT ["/usr/local/bin/flightdeck"]
