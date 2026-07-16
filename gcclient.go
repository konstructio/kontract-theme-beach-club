package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// upstreamTimeout bounds every call to the groundcover API. It is intentionally
// shorter than the frontend's own RPC timeout so a slow upstream degrades to
// sample mode rather than hanging the browser.
const upstreamTimeout = 15 * time.Second

// GCClient talks to the groundcover ingest API. It exposes the two transports
// the Kontrol Room needs: PromQL (instant + range) and the stateless MCP
// JSON-RPC endpoint. It is safe for concurrent use.
//
// The client never logs or echoes the API key.
type GCClient struct {
	cfg  Config
	http *http.Client
}

// NewGCClient constructs a GCClient with a shared, connection-pooling
// http.Client. Pass the loaded Config; the client reads the base URL, key, and
// headers from it on every request.
func NewGCClient(cfg Config) *GCClient {
	return &GCClient{
		cfg: cfg,
		http: &http.Client{
			Timeout: upstreamTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// authHeaders sets the three headers every groundcover request requires. It is
// the single place the API key is attached, keeping the secret off every other
// code path.
func (c *GCClient) authHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.cfg.GroundcoverAPIKey)
	req.Header.Set("X-Tenant-UUID", c.cfg.GroundcoverTenantUUID)
	req.Header.Set("X-Backend-Id", c.cfg.GroundcoverBackendID)
}

// ---------------------------------------------------------------------------
// PromQL
// ---------------------------------------------------------------------------

// PromValue is a single [unixSeconds, value] sample as returned by the
// Prometheus HTTP API (the value arrives as a JSON string).
type PromValue [2]json.RawMessage

// Time returns the sample timestamp in whole unix seconds.
func (v PromValue) Time() (int64, error) {
	var f float64
	if err := json.Unmarshal(v[0], &f); err != nil {
		return 0, err
	}
	return int64(f), nil
}

// Float returns the sample value parsed from its string encoding.
func (v PromValue) Float() (float64, error) {
	var s string
	if err := json.Unmarshal(v[1], &s); err != nil {
		return 0, err
	}
	return strconv.ParseFloat(s, 64)
}

// PromResult is one series (instant: single Value; range: Values) with its
// label set.
type PromResult struct {
	Metric map[string]string `json:"metric"`
	Value  PromValue         `json:"value"`
	Values []PromValue       `json:"values"`
}

// promResponse mirrors the standard Prometheus query response envelope.
type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string       `json:"resultType"`
		Result     []PromResult `json:"result"`
	} `json:"data"`
	ErrorType string `json:"errorType"`
	Error     string `json:"error"`
}

// QueryInstant runs an instant PromQL query and returns the result vector.
func (c *GCClient) QueryInstant(ctx context.Context, promql string) ([]PromResult, error) {
	form := url.Values{}
	form.Set("query", promql)
	return c.promQuery(ctx, "/api/prometheus/api/v1/query", form)
}

// QueryRange runs a range PromQL query between start and end at the given step
// and returns the matrix of series.
func (c *GCClient) QueryRange(ctx context.Context, promql string, start, end time.Time, step time.Duration) ([]PromResult, error) {
	form := url.Values{}
	form.Set("query", promql)
	form.Set("start", strconv.FormatInt(start.Unix(), 10))
	form.Set("end", strconv.FormatInt(end.Unix(), 10))
	form.Set("step", strconv.Itoa(int(step.Seconds())))
	return c.promQuery(ctx, "/api/prometheus/api/v1/query_range", form)
}

// promQuery POSTs a form-encoded PromQL request and decodes the envelope.
func (c *GCClient) promQuery(ctx context.Context, path string, form url.Values) ([]PromResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.GroundcoverAPIURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build promql request: %w", err)
	}
	c.authHeaders(req)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("promql request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("read promql response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("promql upstream status %d", resp.StatusCode)
	}

	var pr promResponse
	if err := json.Unmarshal(body, &pr); err != nil {
		return nil, fmt.Errorf("decode promql response: %w", err)
	}
	if pr.Status != "success" {
		return nil, fmt.Errorf("promql error: %s: %s", pr.ErrorType, pr.Error)
	}
	return pr.Data.Result, nil
}

// ScalarInstant runs an instant query expected to return a single scalar and
// returns it, or 0 when the result vector is empty.
func (c *GCClient) ScalarInstant(ctx context.Context, promql string) (float64, error) {
	res, err := c.QueryInstant(ctx, promql)
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return res[0].Value.Float()
}

// ---------------------------------------------------------------------------
// MCP (stateless JSON-RPC over SSE)
// ---------------------------------------------------------------------------

// mcpTimeRange is the default lookback window for MCP tool calls that do not
// specify their own period.
const mcpTimeRange = "PT1H"

// jsonRPCRequest is the JSON-RPC 2.0 envelope for an MCP tools/call.
type jsonRPCRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      int            `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

// CallTool invokes a groundcover MCP tool by name and unmarshals the tool's
// JSON result (result.content[0].text is itself a JSON string) into out.
//
// The groundcover MCP endpoint is stateless — no initialize handshake is
// required before tools/call. The response body is a Server-Sent-Events stream;
// the first "data:" line carries the JSON-RPC response.
func (c *GCClient) CallTool(ctx context.Context, name string, arguments map[string]any, out any) error {
	reqBody := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
		Params: map[string]any{
			"name":      name,
			"arguments": arguments,
		},
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal mcp request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.GroundcoverAPIURL+"/api/mcp", bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("build mcp request: %w", err)
	}
	c.authHeaders(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("mcp request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("mcp upstream status %d", resp.StatusCode)
	}

	text, err := firstDataPayload(resp.Body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if text == "" {
		return fmt.Errorf("mcp tool %q returned no content", name)
	}
	if err := json.Unmarshal([]byte(text), out); err != nil {
		return fmt.Errorf("decode mcp tool result: %w", err)
	}
	return nil
}

// mcpEnvelope is the JSON-RPC response carried on the SSE data line.
type mcpEnvelope struct {
	Result *struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// firstDataPayload scans an SSE stream for the first "data:" line, parses it as
// a JSON-RPC envelope, and returns result.content[0].text (the tool's JSON
// payload string).
func firstDataPayload(r io.Reader) (string, error) {
	scanner := bufio.NewScanner(r)
	// SSE data lines can be large (full result sets); grow the buffer.
	scanner.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var env mcpEnvelope
		if err := json.Unmarshal([]byte(payload), &env); err != nil {
			return "", fmt.Errorf("decode mcp envelope: %w", err)
		}
		if env.Error != nil {
			return "", fmt.Errorf("mcp error %d: %s", env.Error.Code, env.Error.Message)
		}
		if env.Result == nil || len(env.Result.Content) == 0 {
			return "", nil
		}
		return env.Result.Content[0].Text, nil
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read mcp stream: %w", err)
	}
	return "", fmt.Errorf("mcp stream contained no data line")
}

// QueryGCQL is a convenience wrapper that calls an MCP query_* tool with a gcQL
// string and period, unmarshaling the row array into out.
func (c *GCClient) QueryGCQL(ctx context.Context, tool, gcql, period string, out any) error {
	if period == "" {
		period = mcpTimeRange
	}
	return c.CallTool(ctx, tool, map[string]any{
		"query":  gcql,
		"period": period,
	}, out)
}
