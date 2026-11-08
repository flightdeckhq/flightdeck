package storage

import (
	"database/sql/driver"
	"fmt"
	"time"
)

// Time scans a timestamp from either backend, whatever shape the driver
// hands back: a time.Time (Postgres always; SQLite for a column
// declared TIMESTAMP), or the TimeLayout text SQLite returns for an
// expression such as MAX(started_at) or DateTrunc, whose declared type
// is unknown to the driver. NULL scans as Valid == false.
//
// Use it where a timestamp is computed rather than read straight from a
// column; plain time.Time and sql.NullTime work for columns.
type Time struct {
	Time  time.Time
	Valid bool
}

// Scan implements sql.Scanner.
func (t *Time) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*t = Time{}
		return nil
	case time.Time:
		*t = Time{Time: v, Valid: true}
		return nil
	case string:
		return t.parse(v)
	case []byte:
		return t.parse(string(v))
	}
	return fmt.Errorf("storage: cannot scan %T into Time", src)
}

func (t *Time) parse(s string) error {
	parsed, err := ParseTime(s)
	if err != nil {
		return err
	}
	*t = Time{Time: parsed, Valid: true}
	return nil
}

// Value implements driver.Valuer, so a Time can be bound as a parameter.
func (t Time) Value() (driver.Value, error) {
	if !t.Valid {
		return nil, nil
	}
	return t.Time, nil
}

// ParseTime parses a timestamp as SQLite stores or computes it: the
// fixed TimeLayout, or the shapes SQLite's date functions produce
// (space or T separator, optional fraction, optional Z).
func ParseTime(s string) (time.Time, error) {
	for _, layout := range []string{
		TimeLayout,
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("storage: %q is not a timestamp", s)
}
