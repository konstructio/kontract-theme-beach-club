package main

import (
	"os"
	"strings"
)

// Config holds all runtime configuration for the Kontrol Room theme server.
// Every field is sourced from an environment variable with a sensible default,
// so the zero-config path (no env set) still boots into sample mode.
type Config struct {
	// Port is the TCP port the HTTP server listens on.
	Port string
	// GroundcoverAPIURL is the base URL of the groundcover ingest API.
	GroundcoverAPIURL string
	// GroundcoverAPIKey is the bearer token for the groundcover API. When
	// empty the server runs in "sample mode" and never calls upstream.
	GroundcoverAPIKey string
	// GroundcoverTenantUUID is sent as the X-Tenant-UUID header.
	GroundcoverTenantUUID string
	// GroundcoverBackendID is sent as the X-Backend-Id header.
	GroundcoverBackendID string
	// Cluster is the groundcover cluster name every query is filtered to.
	Cluster string
	// GroundcoverUIURL is the base URL of the groundcover web UI the theme
	// deeplinks into. Never has a trailing slash.
	GroundcoverUIURL string
}

// LoadConfig reads configuration from the environment, applying defaults for
// every value except the API key (whose absence intentionally selects sample
// mode).
func LoadConfig() Config {
	return Config{
		Port:                  envOr("PORT", "8080"),
		GroundcoverAPIURL:     strings.TrimRight(envOr("GROUNDCOVER_API_URL", "https://ingest.groundcover.civo.io"), "/"),
		GroundcoverAPIKey:     os.Getenv("GROUNDCOVER_API_KEY"),
		GroundcoverTenantUUID: envOr("GROUNDCOVER_TENANT_UUID", "cf62870d-7985-4b5d-953b-b122d2e102f1"),
		GroundcoverBackendID:  envOr("GROUNDCOVER_BACKEND_ID", "groundcover"),
		Cluster:               envOr("GC_CLUSTER", "konstruct-control-plane-jd-relentless-today"),
		GroundcoverUIURL:      strings.TrimRight(envOr("GROUNDCOVER_UI_URL", "https://groundcover.civo.io"), "/"),
	}
}

// Live reports whether the server has credentials to call the groundcover API.
// When false, every endpoint serves embedded sample data.
func (c Config) Live() bool {
	return c.GroundcoverAPIKey != ""
}

// envOr returns the value of the environment variable named by key, or def when
// the variable is unset or empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
