package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// fakeInserter records the inserts storeEvent makes; contentErr fails
// the insert with content, insertErr the insert without it.
type fakeInserter struct {
	withContent []writer.EventRow
	alone       []writer.EventRow
	contentErr  error
	insertErr   error
}

func (f *fakeInserter) InsertEventWithContent(_ context.Context, row writer.EventRow, _ json.RawMessage) (string, error) {
	f.withContent = append(f.withContent, row)
	if f.contentErr != nil {
		return "", f.contentErr
	}
	return "event-with-content", nil
}

func (f *fakeInserter) InsertEvent(_ context.Context, row writer.EventRow) (string, error) {
	f.alone = append(f.alone, row)
	if f.insertErr != nil {
		return "", f.insertErr
	}
	return "event-alone", nil
}

func contentEvent() consumer.EventPayload {
	return consumer.EventPayload{
		EventType: "post_call", SessionID: "22222222-2222-4222-8222-222222222222",
		HasContent: true, Content: json.RawMessage(`{"provider":"openai","messages":[]}`),
	}
}

// Content the database can never store (the writer reports
// ErrEventContent) is dropped: the event is stored alone with
// has_content false and no error is returned, so Process returns nil
// and the consumer acks the event instead of redelivering it into the
// same failure.
func TestStoreEventStoresTheEventAloneWhenItsContentIsRejected(t *testing.T) {
	w := &fakeInserter{contentErr: fmt.Errorf("%w: insert event content: not-null violation", writer.ErrEventContent)}
	id, err := storeEvent(context.Background(), w, contentEvent(), writer.EventRow{SessionID: "s"}, true)
	if err != nil {
		t.Fatalf("storeEvent returned %v: the event would be redelivered, not acked", err)
	}
	if len(w.withContent) != 1 || !w.withContent[0].HasContent {
		t.Fatalf("first insert = %+v, want one with content claiming it", w.withContent)
	}
	if len(w.alone) != 1 || w.alone[0].HasContent {
		t.Fatalf("second insert = %+v, want the event alone with has_content false", w.alone)
	}
	if id != "event-alone" {
		t.Errorf("event id = %q, want the stored row's", id)
	}
}

// Any other failure of the insert with content (a dropped connection, a
// timeout) is returned with nothing else written, so the event is
// redelivered and retried whole, content included.
func TestStoreEventRetriesATransientContentFailure(t *testing.T) {
	transient := errors.New("conn closed")
	w := &fakeInserter{contentErr: transient}
	if _, err := storeEvent(context.Background(), w, contentEvent(), writer.EventRow{}, true); !errors.Is(err, transient) {
		t.Fatalf("storeEvent returned %v, want the transient error", err)
	}
	if len(w.alone) != 0 {
		t.Errorf("the event was stored without its content after a transient failure: %+v", w.alone)
	}
}

// The fallback's own insert failing is returned, so the event is
// redelivered rather than lost.
func TestStoreEventReturnsTheFallbackInsertsError(t *testing.T) {
	down := errors.New("db down")
	w := &fakeInserter{contentErr: writer.ErrEventContent, insertErr: down}
	if _, err := storeEvent(context.Background(), w, contentEvent(), writer.EventRow{}, true); !errors.Is(err, down) {
		t.Fatalf("storeEvent returned %v, want the fallback insert's error", err)
	}
}

// Without content to store (capture off, no content field, a JSON null)
// the event is stored alone with has_content false, whatever it claims.
func TestStoreEventWithoutContentToStore(t *testing.T) {
	for name, tc := range map[string]struct {
		hasContent bool
		content    json.RawMessage
	}{
		"capture off":     {false, json.RawMessage(`{"messages":[]}`)},
		"no content":      {true, nil},
		"null content":    {true, json.RawMessage(`null`)},
		"empty raw value": {true, json.RawMessage(``)},
	} {
		e := contentEvent()
		e.Content = tc.content
		w := &fakeInserter{}
		if _, err := storeEvent(context.Background(), w, e, writer.EventRow{HasContent: true}, tc.hasContent); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(w.withContent) != 0 || len(w.alone) != 1 || w.alone[0].HasContent {
			t.Errorf("%s: inserts with content %d, alone %+v", name, len(w.withContent), w.alone)
		}
	}
}
