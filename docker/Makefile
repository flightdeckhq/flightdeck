.PHONY: dev dev-reset down logs ps build

COMPOSE := docker compose -f docker-compose.yml -f docker-compose.dev.yml

dev: ## Start full local dev environment
	$(COMPOSE) up --build -d
	@echo "Flightdeck dev environment starting..."
	@echo "Dashboard: http://localhost:4000"

dev-reset: down ## Wipe all volumes and restart
	$(COMPOSE) down -v
	$(COMPOSE) up --build -d

down: ## Stop local dev environment
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps

build: ## Build all service images
	$(COMPOSE) build
