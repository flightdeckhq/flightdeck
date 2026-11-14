package utc

import (
	"testing"
	"time"
)

func TestImportingThePackageMakesTheLocalZoneUTC(t *testing.T) {
	if time.Local != time.UTC {
		t.Fatalf("time.Local is %v, want UTC", time.Local)
	}
	stamp := time.Date(2026, 7, 1, 12, 0, 0, 0, time.Local).Format(time.RFC3339)
	if stamp != "2026-07-01T12:00:00Z" {
		t.Fatalf("a local time formats as %s, want the Z suffix", stamp)
	}
}
