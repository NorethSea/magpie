package gateway

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/edit"
	"github.com/yetone/magpie/internal/provider"
)

// codexModelsSnapshot keeps the backend's reply before windows, picks and
// multi-agent policy are applied. Codex's own cache keeps the rendered list
// and the provider's fetched list can be older than a successful relay.
type codexModelsSnapshot struct {
	Fetched time.Time `json:"fetched"`
	ETag    string    `json:"etag"`
	Models  []any     `json:"models"`
}

// codexModelsCachePath separates users, workspace seats, upstreams and
// client versions. The subject survives token rotation; an opaque token
// uses its fingerprint instead. Neither credentials nor identity fields
// are written to disk.
func codexModelsCachePath(r *http.Request) string {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		return ""
	}
	user := "token:" + token
	if parts := strings.Split(token, "."); len(parts) == 3 {
		var claims struct {
			Subject string `json:"sub"`
		}
		b, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err == nil && json.Unmarshal(b, &claims) == nil && claims.Subject != "" {
			user = "sub:" + claims.Subject
		}
	}
	identity, _ := json.Marshal([]string{provider.CodexBase, r.URL.RawQuery, r.Header.Get("ChatGPT-Account-ID"), user})
	sum := sha256.Sum256(identity)
	return filepath.Join(appdir.Cache(), "codex-native-models", hex.EncodeToString(sum[:])+".json")
}

func usableCodexModels(models []any) bool {
	if len(models) == 0 {
		return false
	}
	for _, m := range models {
		o, _ := m.(map[string]any)
		if slug, _ := o["slug"].(string); slug == "" {
			return false
		}
	}
	return true
}

func rememberCodexModels(r *http.Request, models []any, etag string) error {
	path := codexModelsCachePath(r)
	if path == "" {
		return nil
	}
	b, err := json.Marshal(codexModelsSnapshot{Fetched: time.Now(), ETag: etag, Models: models})
	if err != nil {
		return err
	}
	return edit.WriteAtomic(path, b)
}

func cachedCodexModels(r *http.Request) ([]any, string, bool) {
	path := codexModelsCachePath(r)
	if path == "" {
		return nil, "", false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", false
	}
	var snapshot codexModelsSnapshot
	if json.Unmarshal(b, &snapshot) != nil || !usableCodexModels(snapshot.Models) {
		return nil, "", false
	}
	return snapshot.Models, snapshot.ETag, true
}
