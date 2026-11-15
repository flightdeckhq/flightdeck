package main

import (
	"context"
	"log/slog"
	"strings"

	"github.com/flightdeckhq/flightdeck/internal/connect"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// agentRegistry is the connectors the start-up check of the agents
// asks, their commands run in env. The binary tests replace it with an
// empty registry unless a test is about the check, so no other test's
// start runs an agent's command.
var agentRegistry = connect.DefaultIn

// agentEnvironment is the environment the check runs the agents'
// commands in: environ, the one the binary was started with, without
// any FLIGHTDECK_ variable. The server's settings and secrets are no
// business of an agent's CLI or of what that CLI starts: the database
// URL with its password, a supplied dashboard token, an agent token,
// and the variables the binary sets for its services (the JWT secret,
// the database URL), which are set after environ is read in any case.
// Names are compared without case, as Windows reads them.
func agentEnvironment(environ []string) []string {
	kept := make([]string, 0, len(environ))
	for _, kv := range environ {
		if !strings.HasPrefix(strings.ToUpper(kv), "FLIGHTDECK_") {
			kept = append(kept, kv)
		}
	}
	return kept
}

// startAgentCheck runs the start-up check of the coding agents
// (connect.CheckReporting) for the instance listening on listen, in a
// goroutine of its own, and returns at once: the start never waits for
// an agent's command. Each line it finds is logged as a warning, each
// command that failed at debug level, and nothing once ctx is done:
// the stop cancels it. wait blocks until the check has ended, which
// cancelling bounds by the connectors' own kill of their commands.
func startAgentCheck(ctx context.Context, reg connect.Registry, listen string, logger *slog.Logger) (wait func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		lines, errs := connect.CheckReporting(ctx, reg, listen)
		if ctx.Err() != nil {
			return
		}
		for _, err := range errs {
			logger.Debug("could not read where a coding agent reports", "err", err)
		}
		for _, line := range lines {
			logger.Warn(line)
		}
	}()
	return func() { <-done }
}

// recordInstance writes the data dir's instance file for a loopback
// instance listening on listen, which `flightdeck connect` reads to
// find it, and returns the function that removes it at the stop. A file
// that cannot be written is a warning, not a failed start: connect then
// does not find this instance, and says what it does instead.
func recordInstance(dir, listen string, pid int) (remove func()) {
	if err := datadir.WriteInstance(dir, datadir.Instance{Listen: listen, PID: pid}); err != nil {
		slog.Warn("flightdeck connect will not find this instance: its address could not be recorded in the data dir", "err", err)
		return func() {}
	}
	return func() {
		if err := datadir.RemoveInstance(dir); err != nil {
			slog.Warn("the data dir still names this instance after its stop", "err", err)
		}
	}
}
