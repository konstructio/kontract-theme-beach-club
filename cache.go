package main

import (
	"context"
	"sync"
	"time"
)

// cacheTTL is how long a rendered endpoint response is served from memory
// before the next request triggers a fresh upstream fetch.
const cacheTTL = 30 * time.Second

// cacheEntry is a rendered response plus its expiry.
type cacheEntry struct {
	payload []byte
	expires time.Time
}

// inflight coordinates concurrent callers waiting on the same upstream fetch so
// only one request in flight per key touches groundcover (single-flight).
type inflight struct {
	done    chan struct{}
	payload []byte
	err     error
}

// Cache is an in-memory, per-key response cache with a fixed TTL and
// single-flight de-duplication of concurrent misses. It stores fully rendered
// JSON payloads keyed by endpoint+params. Safe for concurrent use.
type Cache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	calls   map[string]*inflight
	now     func() time.Time // injectable clock for tests
}

// NewCache returns an empty Cache using the wall clock.
func NewCache() *Cache {
	return &Cache{
		entries: make(map[string]cacheEntry),
		calls:   make(map[string]*inflight),
		now:     time.Now,
	}
}

// Do returns the cached payload for key when fresh; otherwise it runs build
// exactly once across all concurrent callers, caches the result for cacheTTL,
// and returns it. Concurrent callers for the same key block on the single
// in-flight build rather than each calling upstream.
func (c *Cache) Do(ctx context.Context, key string, build func(context.Context) ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && c.now().Before(e.expires) {
		payload := e.payload
		c.mu.Unlock()
		return payload, nil
	}
	if call, ok := c.calls[key]; ok {
		// A build is already running for this key; wait for it.
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.payload, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	// We own the build for this key.
	call := &inflight{done: make(chan struct{})}
	c.calls[key] = call
	c.mu.Unlock()

	payload, err := build(ctx)

	c.mu.Lock()
	call.payload, call.err = payload, err
	if err == nil {
		c.entries[key] = cacheEntry{payload: payload, expires: c.now().Add(cacheTTL)}
	}
	delete(c.calls, key)
	close(call.done)
	c.mu.Unlock()

	return payload, err
}
