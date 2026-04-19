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

lint:
	helm lint $(CHART)

template:
	helm template $(RELEASE) $(CHART) --values $(VALUES)

install:
	helm install $(RELEASE) $(CHART) \
	  --namespace $(NS) --create-namespace \
	  --values $(VALUES)

upgrade:
	helm upgrade $(RELEASE) $(CHART) \
	  --namespace $(NS) \
	  --values $(VALUES)

uninstall:
	helm uninstall $(RELEASE) --namespace $(NS)

# Sync bundled Postgres migrations from docker/postgres/migrations into the
# chart directory so `.Files.Glob` can package them. Run this whenever a new
# migration is added so Helm deployments stay in lockstep with docker-compose.
sync-migrations:
	rm -f migrations/*.sql
	cp ../docker/postgres/migrations/*.sql migrations/
