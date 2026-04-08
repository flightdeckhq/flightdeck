package models

import "time"

// EventContent represents a row in the event_content table.
type EventContent struct {
	EventID      string    `json:"event_id"`
	SessionID    string    `json:"session_id"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	SystemPrompt *string   `json:"system_prompt"`
	Messages     []byte    `json:"messages"`    // JSONB
	Tools        []byte    `json:"tools"`       // JSONB
	Response     []byte    `json:"response"`    // JSONB
	CapturedAt   time.Time `json:"captured_at"`
}
