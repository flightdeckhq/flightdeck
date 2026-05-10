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
