# Multi-stage build: Node build → nginx serve
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Final stage. SHA-pinned base image so a downstream registry update
# can't change what we ship at the same tag. Bump the digest
# deliberately; the tag (1.25-alpine) is documented for human
# readability only.
#
# Bump policy:
#   1. Watch upstream nginx for security advisories at
#      https://nginx.org/en/security_advisories.html.
#   2. When a CVE applies to the running version (1.25.x branch) OR
#      every ~3 months as a routine refresh, run:
#        docker pull nginx:1.25-alpine
#      and copy the printed Digest into this directive. Update the
#      tag in the comment on the next line if the pulled tag changed
#      (e.g. nginx 1.25 EOL → 1.26-alpine).
#   3. Test locally: ``docker build dashboard/`` succeeds and the
#      Dashboard CI smoke (.github/workflows/ci.yml) passes against
#      the new digest. The smoke builds this exact image so a CVE-
#      bumped digest that breaks the cache-control or non-root
#      contract surfaces immediately.
#   4. Land the bump in a focused PR (one digest, one commit) so the
#      diff is unambiguous if it ever needs to be reverted.
FROM nginx:1.25-alpine@sha256:516475cc129da42866742567714ddc681e5eed7b9ee0b9e9c015e464b4221a00
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Run as the unprivileged ``nginx`` user (UID 101 in the alpine
# image) instead of root. The base image's nginx.conf already
# declares ``user nginx;`` for worker processes, but the master
# process inherits the container UID — a container compromise as
# root has wider blast radius than as a service user. We only need
# to make the runtime-writable paths owned by the nginx user; the
# config + html directories stay root-owned (read-only is fine for
# nginx's needs).
RUN touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx
USER nginx

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
