package main

import (
	"net"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

// The binary's local time zone is UTC: the query API formats the
// timestamps it reads in the process's zone, and its contract is UTC.
// The zone is a package variable of time that every goroutine reads
// (time.Now does). Goroutines run before main does: the embedded NATS
// server's pse package starts a timer when it is loaded, which stats a
// file every second from then on. A write to the zone from the start
// path is therefore a data race with whatever is already running.

// The zone is UTC from the moment the process starts, in the test
// process as in the binary: it is set while the packages are loaded
// (internal/utc), before any goroutine exists.
func TestLocalZoneIsUTC(t *testing.T) {
	if time.Local != time.UTC {
		t.Fatalf("time.Local is %v, want UTC", time.Local)
	}
	if name, offset := time.Now().Zone(); name != "UTC" || offset != 0 {
		t.Fatalf("the local zone is %s%+d, want UTC", name, offset)
	}
}

// The server's start path with a goroutine that was already running and
// reads the zone the whole time, as the NATS timer's goroutine and
// every other one does. The port is taken, so the start ends at the
// bind; a start path that writes the zone on its way there is reported
// by the race detector, which fails this test.
func TestRun_TheStartPathDoesNotWriteTheZone(t *testing.T) {
	if !raceBuild {
		t.Skip("needs the race detector: go test -race")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()

	// The reader runs before the start path begins and until after it
	// has returned. Its loop synchronises with this goroutine only
	// through stop, which is stored after the start path is done, so
	// its reads during the start are ordered with nothing.
	var stop atomic.Bool
	reading := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		close(reading)
		for !stop.Load() {
			_ = time.Now()
		}
	}()
	<-reading

	code := run([]string{"--listen", ln.Addr().String(), "--data-dir", tempDir(t)}, devnull, devnull)
	stop.Store(true)
	<-done
	if code != 1 {
		t.Fatalf("exit status %d, want 1: the port is taken", code)
	}
}
