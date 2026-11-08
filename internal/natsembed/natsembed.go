// Package natsembed runs a NATS server inside the flightdeck process:
// JetStream on, store under the data dir, no listener, with the clients
// connected over in-process pipes.
package natsembed

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// readyTimeout bounds the wait for the server to accept connections.
// Starting JetStream on an existing store replays its index; ten seconds
// covers a store of the stream's full 5 GiB on a laptop disk.
const readyTimeout = 10 * time.Second

// memoryStoreLimit caps JetStream's memory storage. The FLIGHTDECK
// stream is file-backed, so memory storage holds nothing of ours; 64 MiB
// keeps the server from reserving a share of the machine's RAM for it.
const memoryStoreLimit = 64 << 20

// Options configures the embedded server.
type Options struct {
	// StoreDir is where JetStream keeps its files.
	StoreDir string
	// StreamMaxBytes is the FLIGHTDECK stream's size limit. The server's
	// file-store limit is set to twice it, so creating the stream never
	// depends on the free disk space the server would otherwise measure
	// at start (and refuse a stream larger than 75% of).
	StreamMaxBytes int64
}

// Server is the running embedded server.
type Server struct {
	ns *server.Server
}

// Start runs the server and waits until it accepts connections.
func Start(o Options) (*Server, error) {
	opts := &server.Options{
		ServerName:         "flightdeck-embedded",
		DontListen:         true,
		JetStream:          true,
		StoreDir:           o.StoreDir,
		JetStreamMaxMemory: memoryStoreLimit,
		JetStreamMaxStore:  2 * o.StreamMaxBytes,
		NoSigs:             true,
	}
	ns, err := server.NewServer(opts)
	if err != nil {
		return nil, fmt.Errorf("embedded NATS: %w", err)
	}
	ns.SetLoggerV2(slogLogger{}, false, false, false)
	go ns.Start()
	if !ns.ReadyForConnections(readyTimeout) {
		ns.Shutdown()
		return nil, fmt.Errorf("embedded NATS did not become ready within %s", readyTimeout)
	}
	return &Server{ns: ns}, nil
}

// Connect opens an in-process client connection.
func (s *Server) Connect(name string) (*nats.Conn, error) {
	nc, err := nats.Connect("", nats.InProcessServer(s.ns), nats.Name(name))
	if err != nil {
		return nil, fmt.Errorf("embedded NATS connection: %w", err)
	}
	return nc, nil
}

// Shutdown stops the server and waits for it to finish, so every write
// acknowledged before the call is on disk.
func (s *Server) Shutdown() {
	s.ns.Shutdown()
	s.ns.WaitForShutdown()
}

// slogLogger forwards the server's log to slog. Notices are the server's
// start-up narration and go to debug; warnings and errors keep their
// level.
type slogLogger struct{}

func (slogLogger) Noticef(format string, v ...any) { slog.Debug("nats: " + fmt.Sprintf(format, v...)) }
func (slogLogger) Warnf(format string, v ...any)   { slog.Warn("nats: " + fmt.Sprintf(format, v...)) }
func (slogLogger) Fatalf(format string, v ...any)  { slog.Error("nats: " + fmt.Sprintf(format, v...)) }
func (slogLogger) Errorf(format string, v ...any)  { slog.Error("nats: " + fmt.Sprintf(format, v...)) }
func (slogLogger) Debugf(format string, v ...any)  { slog.Debug("nats: " + fmt.Sprintf(format, v...)) }
func (slogLogger) Tracef(format string, v ...any)  { slog.Debug("nats: " + fmt.Sprintf(format, v...)) }
