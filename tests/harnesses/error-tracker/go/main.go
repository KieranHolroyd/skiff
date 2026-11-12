// Go harness: real sentry-go against the Yoal app error tracker.
//
// Every scenario is stable so running the harness twice checks grouping. The fake
// `sk_test_fake_secret_123456` extra proves the tracker scrubs it before storage.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
)

type sentEvent struct {
	Label   string `json:"label"`
	EventID string `json:"eventId,omitempty"`
}

func main() {
	dsn := os.Getenv("ERROR_TRACKER_DSN")
	if dsn == "" {
		dsn = os.Getenv("SENTRY_DSN")
	}
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "ERROR_TRACKER_DSN (or SENTRY_DSN) is required")
		os.Exit(2)
	}

	lang := "go"
	release := os.Getenv("HARNESS_RELEASE")
	if release == "" {
		release = lang + "-harness@1.0.0"
	}
	environment := os.Getenv("HARNESS_ENV")
	if environment == "" {
		environment = "harness"
	}

	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Release:          release,
		Environment:      environment,
		EnableTracing:    true,
		TracesSampleRate: 1.0,
		SendDefaultPII:   false,
		AttachStacktrace: true,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "sentry.Init: %v\n", err)
		os.Exit(1)
	}

	sentry.ConfigureScope(func(scope *sentry.Scope) {
		scope.SetTag("lang", lang)
		scope.SetTag("harness", "error-tracker")
	})

	sent := make([]sentEvent, 0, 6)
	capture := func(label string, id *sentry.EventID) {
		eventID := ""
		if id != nil {
			eventID = string(*id)
		}
		sent = append(sent, sentEvent{Label: label, EventID: eventID})
		fmt.Printf("sent %s event_id=%s\n", label, eventID)
	}

	// 1. The simplest exception.
	capture("simple", sentry.CaptureException(errors.New("go-harness: simple failure")))

	// 2. A wrapper with a cause, to check exception chains.
	root := errors.New("go-harness: root cause")
	wrapper := fmt.Errorf("go-harness: wrapper failure: %w", root)
	capture("chained", sentry.CaptureException(wrapper))

	// 3. A message event with no exception.
	capture("message", sentry.CaptureEvent(&sentry.Event{
		Message: "go-harness: warning message",
		Level:   sentry.LevelWarning,
	}))

	// 4. Tags, user and extra context on a scoped event.
	var scopedID *sentry.EventID
	sentry.WithScope(func(scope *sentry.Scope) {
		scope.SetTag("scenario", "tags")
		scope.SetTag("token", "sk_test_fake_secret_123456")
		scope.SetUser(sentry.User{ID: "user_123"})
		scope.SetContext("harness", sentry.Context{"orderId": 42})
		scopedID = sentry.CaptureException(errors.New("go-harness: scoped failure"))
	})
	capture("tags", scopedID)

	// 5. Values that must be masked before they reach the fingerprint.
	capture("normalize", sentry.CaptureException(errors.New(
		"go-harness: order 12345 failed for user 550e8400-e29b-41d4-a716-446655440000 after 3 tries",
	)))

	// 6. Telemetry the tracker must accept and discard.
	transaction := sentry.StartTransaction(context.Background(), "go-harness-transaction")
	transaction.Finish()
	fmt.Println("sent telemetry transaction")

	flushed := sentry.Flush(5 * time.Second)
	if !flushed {
		fmt.Fprintln(os.Stderr, "sentry.Flush() returned false: the event(s) may not have reached the tracker")
		os.Exit(1)
	}

	out, err := json.MarshalIndent(map[string]any{
		"lang":        lang,
		"release":     release,
		"environment": environment,
		"sent":        sent,
		"flushed":     flushed,
	}, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "json: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(out))
}
