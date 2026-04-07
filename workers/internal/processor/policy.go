package processor

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const blockThresholdPct = 100

// PolicyEvaluator checks token thresholds after each post_call event.
// When a threshold is crossed it writes a directive to the directives table.
// It does NOT deliver the directive -- the ingestion API picks it up on the
// next sensor POST.
type PolicyEvaluator struct {
	pool *pgxpool.Pool
}

// NewPolicyEvaluator creates a PolicyEvaluator.
func NewPolicyEvaluator(pool *pgxpool.Pool) *PolicyEvaluator {
	return &PolicyEvaluator{pool: pool}
}

// Evaluate checks the session's token usage against any applicable policy.
// Writes a directive to the directives table when block_at_pct is crossed.
func (pe *PolicyEvaluator) Evaluate(ctx context.Context, sessionID string) error {
	// Look up session's tokens_used, token_limit, and flavor
	var tokensUsed int
	var tokenLimit *int
	var flavor string

	err := pe.pool.QueryRow(ctx, `
		SELECT tokens_used, token_limit, flavor
		FROM sessions WHERE session_id = $1::uuid
	`, sessionID).Scan(&tokensUsed, &tokenLimit, &flavor)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	// No limit set on session -- look up flavor policy
	if tokenLimit == nil {
		var policyLimit *int
		var blockAtPct *int
		err := pe.pool.QueryRow(ctx, `
			SELECT p.token_limit, p.block_at_pct
			FROM agents a JOIN policies p ON a.policy_id = p.id
			WHERE a.flavor = $1
		`, flavor).Scan(&policyLimit, &blockAtPct)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // No policy -- nothing to enforce
			}
			return err
		}
		if policyLimit == nil {
			return nil
		}
		tokenLimit = policyLimit
	}

	if *tokenLimit <= 0 {
		return nil
	}

	pctUsed := (tokensUsed * 100) / *tokenLimit
	if pctUsed >= blockThresholdPct {
		// Check if a block directive already exists for this session
		var exists bool
		err := pe.pool.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM directives
				WHERE session_id = $1::uuid
				  AND action = 'shutdown'
				  AND delivered_at IS NULL
			)
		`, sessionID).Scan(&exists)
		if err != nil {
			return err
		}
		if exists {
			return nil // Already issued
		}

		_, err = pe.pool.Exec(ctx, `
			INSERT INTO directives (session_id, flavor, action, reason, issued_by)
			VALUES ($1::uuid, $2, 'shutdown', 'token_budget_exceeded', 'policy_evaluator')
		`, sessionID, flavor)
		if err != nil {
			return err
		}
		slog.Info("policy: block directive issued", "session_id", sessionID, "tokens_used", tokensUsed, "limit", *tokenLimit)
	}

	return nil
}
