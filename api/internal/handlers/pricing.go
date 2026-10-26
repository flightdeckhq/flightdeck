package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// DegradeTargetsHandler handles GET /v1/pricing/models.
//
// @Summary      List degrade targets
// @Description  Returns the models a token policy's degrade_to may name: models priced on their provider's own API that generate output (embedding models are excluded), are not operator aliases or fine-tune price keys (ft:<base>), and are not past their deprecation date. Sorted by provider, then model id. The policy editor offers exactly this list, and POST / PUT /v1/policies reject any other degrade_to.
// @Tags         policies
// @Produce      json
// @Success      200  {array}   store.PricedModel
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/pricing/models [get]
func DegradeTargetsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		models, err := s.DegradeTargets(r.Context())
		if err != nil {
			slog.Error("list degrade targets error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if models == nil {
			models = []store.PricedModel{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(models)
	}
}
