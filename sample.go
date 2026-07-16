package main

import (
	"encoding/json"
	"fmt"
)

// Sampler serves the embedded snapshot (sample-data.json) when the server has
// no API key or an upstream call fails. Each section is stored as raw JSON so
// it can be returned verbatim with a "sample":true marker injected.
type Sampler struct {
	sections map[string]json.RawMessage
}

// NewSampler parses the embedded sample-data.json blob. It returns an error if
// the blob is not a JSON object, so a corrupt snapshot fails fast at boot.
func NewSampler(blob []byte) (*Sampler, error) {
	var sections map[string]json.RawMessage
	if err := json.Unmarshal(blob, &sections); err != nil {
		return nil, fmt.Errorf("parse sample-data.json: %w", err)
	}
	return &Sampler{sections: sections}, nil
}

// Section returns the raw sample payload for a top-level key (summary, events,
// …) with "sample":true injected. It reports ok=false when the key is missing
// from the snapshot, letting the caller decide whether that is a 404.
func (s *Sampler) Section(key string, overrides map[string]any) ([]byte, bool) {
	raw, ok := s.sections[key]
	if !ok {
		return nil, false
	}
	return injectSample(raw, overrides), true
}

// Series returns the sample series payload for a given metric with
// "sample":true and the requested range injected, so any requested range is
// served from the single captured 1h snapshot.
func (s *Sampler) Series(metric, rng string) ([]byte, bool) {
	seriesRaw, ok := s.sections["series"]
	if !ok {
		return nil, false
	}
	var byMetric map[string]json.RawMessage
	if err := json.Unmarshal(seriesRaw, &byMetric); err != nil {
		return nil, false
	}
	raw, ok := byMetric[metric]
	if !ok {
		return nil, false
	}
	return injectSample(raw, map[string]any{"metric": metric, "range": rng}), true
}

// injectSample decodes obj into a generic map, applies overrides, sets
// sample=true, and re-marshals. On any decode failure it falls back to
// returning the original bytes unchanged so a malformed section still serves
// something rather than 500ing.
func injectSample(obj json.RawMessage, overrides map[string]any) []byte {
	var m map[string]any
	if err := json.Unmarshal(obj, &m); err != nil {
		return obj
	}
	for k, v := range overrides {
		m[k] = v
	}
	m["sample"] = true
	out, err := json.Marshal(m)
	if err != nil {
		return obj
	}
	return out
}
