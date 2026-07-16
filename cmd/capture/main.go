// Command capture snapshots the live /api/gc/* endpoints of a running Kontrol
// Room server into sample-data.json at the repo root. Run it against a server
// booted in LIVE mode (GROUNDCOVER_API_KEY set) to refresh the offline sample.
//
// Usage:
//
//	BASE_URL=http://localhost:8080 go run ./cmd/capture
//
// The tool captures the 1h range only; the server serves that snapshot for any
// requested range in sample mode. It refuses to write output that contains
// anything resembling a groundcover token, and masks secret-looking values in
// free-text fields.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// secretValue masks values that look like leaked credentials in free-text
// fields (log bodies, event messages).
var secretValue = regexp.MustCompile(`(?i)(token|password|secret|key)([=:])\s*\S+`)

// forbidden are substrings that must never appear in a captured snapshot; their
// presence aborts the write.
var forbidden = []string{"gcsa_", "Bearer "}

// section describes one endpoint to capture and where it lands in the snapshot.
type section struct {
	key  string // top-level key in sample-data.json
	path string // endpoint path + query
}

func main() {
	base := strings.TrimRight(envOr("BASE_URL", "http://localhost:8080"), "/")
	out := envOr("OUT", "sample-data.json")

	client := &http.Client{Timeout: 30 * time.Second}
	ctx := context.Background()

	sections := []section{
		{"mode", "/api/gc/mode"},
		{"summary", "/api/gc/summary"},
		{"workloads", "/api/gc/workloads"},
		{"events", "/api/gc/events?range=1h"},
		{"logs", "/api/gc/logs?range=1h"},
		{"issues", "/api/gc/issues"},
	}
	seriesMetrics := []string{"cpu", "memory", "network"}

	snapshot := make(map[string]any)

	for _, sec := range sections {
		raw, err := fetch(ctx, client, base+sec.path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "capture %s: %v\n", sec.key, err)
			os.Exit(1)
		}
		snapshot[sec.key] = cleanSection(raw)
		fmt.Printf("captured %s\n", sec.key)
	}

	series := make(map[string]any, len(seriesMetrics))
	for _, m := range seriesMetrics {
		raw, err := fetch(ctx, client, base+"/api/gc/series?metric="+m+"&range=1h")
		if err != nil {
			fmt.Fprintf(os.Stderr, "capture series %s: %v\n", m, err)
			os.Exit(1)
		}
		series[m] = cleanSection(raw)
		fmt.Printf("captured series/%s\n", m)
	}
	snapshot["series"] = series

	blob, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal snapshot: %v\n", err)
		os.Exit(1)
	}

	// Safety gate: never persist anything that looks like a credential.
	for _, bad := range forbidden {
		if strings.Contains(string(blob), bad) {
			fmt.Fprintf(os.Stderr, "ABORT: captured data contains forbidden token substring %q\n", bad)
			os.Exit(1)
		}
	}

	if err := os.WriteFile(out, append(blob, '\n'), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", out, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s (%d bytes)\n", out, len(blob))
}

// fetch GETs a URL and returns the decoded JSON object.
func fetch(ctx context.Context, client *http.Client, url string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return obj, nil
}

// cleanSection strips the transient "sample" marker and masks secret-looking
// values recursively so the captured snapshot is clean, live data.
func cleanSection(obj map[string]any) map[string]any {
	delete(obj, "sample")
	maskValue(obj)
	return obj
}

// maskValue walks an arbitrary JSON value, redacting secret-looking substrings
// in every string it finds.
func maskValue(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if s, ok := val.(string); ok {
				t[k] = secretValue.ReplaceAllString(s, "$1$2***")
			} else {
				maskValue(val)
			}
		}
	case []any:
		for i, val := range t {
			if s, ok := val.(string); ok {
				t[i] = secretValue.ReplaceAllString(s, "$1$2***")
			} else {
				maskValue(val)
			}
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
