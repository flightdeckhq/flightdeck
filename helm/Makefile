# helm/Makefile -- wrappers for the flightdeck chart.
#
# Usage:
#   make -C helm lint
#   make -C helm template [VALUES=values.prod.yaml]
#   make -C helm install
#   make -C helm upgrade
#   make -C helm uninstall
#
# The schema migrations are embedded in the flightdeck binary and run at
# every pod start, so the chart carries no migration files.

RELEASE  ?= flightdeck
NS       ?= flightdeck
CHART    := .
VALUES   ?= values.yaml

.PHONY: lint template install upgrade uninstall

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
