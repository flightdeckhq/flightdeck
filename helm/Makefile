# helm/Makefile -- wrappers for the flightdeck chart.
#
# Usage:
#   make -C helm lint
#   make -C helm template [VALUES=values.prod.yaml]
#   make -C helm install
#   make -C helm upgrade
#   make -C helm uninstall
#   make -C helm sync-migrations

RELEASE  ?= flightdeck
NS       ?= flightdeck
CHART    := .
VALUES   ?= values.yaml

.PHONY: lint template install upgrade uninstall sync-migrations

lint: sync-migrations
	helm lint $(CHART)

template: sync-migrations
	helm template $(RELEASE) $(CHART) --values $(VALUES)

install: sync-migrations
	helm install $(RELEASE) $(CHART) \
	  --namespace $(NS) --create-namespace \
	  --values $(VALUES)

upgrade: sync-migrations
	helm upgrade $(RELEASE) $(CHART) \
	  --namespace $(NS) \
	  --values $(VALUES)

uninstall:
	helm uninstall $(RELEASE) --namespace $(NS)

# Sync bundled Postgres migrations from docker/postgres/migrations into the
# chart directory so `.Files.Glob` can package them. The destination
# `migrations/` is a build artifact (gitignored; see DECISIONS.md D136);
# the canonical source is `docker/postgres/migrations/`. The lint /
# template / install / upgrade targets all gate on this prerequisite so
# chart commands always render against an in-sync set of migrations.
# `mkdir -p` ensures a freshly-cloned tree (where the gitignored
# directory is absent) works on first invocation.
sync-migrations:
	mkdir -p migrations/
	rm -f migrations/*.sql
	cp ../docker/postgres/migrations/*.sql migrations/
