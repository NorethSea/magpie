package gateway

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

type nativeModelsReply struct {
	body   []byte
	status int
	slow   bool
}

type nativeModelsRig struct {
	t     *testing.T
	reply atomic.Pointer[nativeModelsReply]
}

func newNativeModelsRig(t *testing.T) *nativeModelsRig {
	t.Helper()
	codexSignedIn(t)
	if err := settings.Save(settings.Settings{FullContext: true}); err != nil {
		t.Fatal(err)
	}
	rig := &nativeModelsRig{t: t}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reply := rig.reply.Load()
		if reply.slow {
			<-r.Context().Done()
			return
		}
		w.Header().Set("ETag", `"native-models"`)
		w.WriteHeader(reply.status)
		w.Write(reply.body)
	}))
	t.Cleanup(up.Close)
	was, wait := provider.CodexBase, codexModelsWait
	provider.CodexBase = up.URL + "/backend-api/codex"
	codexModelsWait = time.Second // the backend waits for cancellation
	t.Cleanup(func() { provider.CodexBase, codexModelsWait = was, wait })
	if err := catalog.SaveLive("codex", provider.CodexBase, []catalog.Model{
		{ID: "gpt-6.1-sol", Context: 272000, MaxContext: 872000},
	}); err != nil {
		t.Fatal(err)
	}
	rig.saveCodexCache([]byte(`{"models":[{"slug":"gpt-6.1-sol","context_window":272000,"max_context_window":872000}]}`))
	return rig
}

// The window fields are projected from the real 2026-10-13 model reply;
// prompt text is not needed to reproduce the 500K -> 272K fallback.
func (rig *nativeModelsRig) backend(window int) {
	rig.t.Helper()
	b, err := os.ReadFile("testdata/codex_native_models.json")
	if err != nil {
		rig.t.Fatal(err)
	}
	var list struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(b, &list); err != nil {
		rig.t.Fatal(err)
	}
	list.Models[0]["context_window"] = window
	rig.reply.Store(&nativeModelsReply{body: mustJSON(list), status: 200})
}

func (rig *nativeModelsRig) saveCodexCache(b []byte) {
	rig.t.Helper()
	if err := os.WriteFile(filepath.Join(catalog.CodexHome(), "models_cache.json"), b, 0o600); err != nil {
		rig.t.Fatal(err)
	}
}

func (rig *nativeModelsRig) list(user, workspace, rotation string) (int, map[string]any, []byte) {
	rig.t.Helper()
	// A new server for each call also proves the fallback survives a restart.
	gw := httptest.NewServer(lanGuard(New().Handler()))
	defer gw.Close()
	req, err := http.NewRequest("GET", gw.URL+CodexPath+"/models?client_version=0.162.0", nil)
	if err != nil {
		rig.t.Fatal(err)
	}
	claims := base64.RawURLEncoding.EncodeToString(mustJSON(map[string]any{"sub": user, "jti": rotation}))
	req.Header.Set("Authorization", "Bearer h."+claims+".s")
	req.Header.Set("ChatGPT-Account-ID", workspace)
	res, err := gw.Client().Do(req)
	if err != nil {
		rig.t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		rig.t.Fatal(err)
	}
	var list struct {
		Models []map[string]any `json:"models"`
	}
	json.Unmarshal(b, &list)
	for _, m := range list.Models {
		if m["slug"] == "gpt-6.1-sol" {
			return res.StatusCode, m, b
		}
	}
	return res.StatusCode, nil, b
}

func TestCodexModelsCacheKeepsLatestNativeWindow(t *testing.T) {
	rig := newNativeModelsRig(t)
	rig.backend(500000)
	if err := settings.Save(settings.Settings{FullContext: true, CodexAgentsV1: true}); err != nil {
		t.Fatal(err)
	}
	if err := provider.Save(provider.Provider{ID: "codex", Contexts: map[string]int{"gpt-6.1-sol": 600000}}); err != nil {
		t.Fatal(err)
	}
	code, m, b := rig.list("user-one", "workspace-one", "first")
	if code != 200 || m["context_window"] != float64(600000) {
		t.Fatalf("explicit window: %d %s", code, b)
	}
	rig.saveCodexCache(b) // Codex keeps the rendered window, not the original.
	p, err := provider.Find("codex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DropContext(*p, "gpt-6.1-sol"); err != nil {
		t.Fatal(err)
	}
	if err := settings.Save(settings.Settings{FullContext: true}); err != nil {
		t.Fatal(err)
	}
	rig.reply.Store(&nativeModelsReply{slow: true})
	code, m, b = rig.list("user-one", "workspace-one", "rotated")
	if code != 200 || m["context_window"] != float64(500000) {
		t.Fatalf("after timeout and removing override: window %v, want latest native 500000 (status %d)", m["context_window"], code)
	}
	if m["max_context_window"] != float64(872000) {
		t.Errorf("max window %v, want 872000", m["max_context_window"])
	}
	if m["multi_agent_version"] != "v2" || m["display_name"] != "GPT-6.1-Sol" {
		t.Errorf("cached native fields lost or policy persisted: %v", m)
	}
	if _, ok := m["auto_compact_token_limit"]; !ok {
		t.Error("the backend's null auto_compact_token_limit was lost")
	}
	rig.saveCodexCache(b)
	// A real reduction from the backend replaces the last success too.
	rig.backend(200000)
	_, m, _ = rig.list("user-one", "workspace-one", "rotated")
	if m["context_window"] != float64(200000) {
		t.Fatalf("new backend window %v, want 200000", m["context_window"])
	}
	for _, bad := range []nativeModelsReply{
		{slow: true}, {status: 503}, {status: 200, body: []byte(`{"models":`)},
		{status: 200, body: []byte(`{"models":[]}`)},
		{status: 200, body: []byte(`{"models":[{"slug":42}]}`)},
	} {
		rig.reply.Store(&bad)
		code, m, _ = rig.list("user-one", "workspace-one", "rotated")
		if code != 200 || m["context_window"] != float64(200000) {
			t.Errorf("failed refresh %+v: window %v, want latest native 200000 (status %d)", bad, m["context_window"], code)
		}
	}
	if err := provider.Save(provider.Provider{ID: "codex", Contexts: map[string]int{"gpt-6.1-sol": 180000}}); err != nil {
		t.Fatal(err)
	}
	_, m, _ = rig.list("user-one", "workspace-one", "rotated")
	if m["context_window"] != float64(180000) {
		t.Errorf("override on cached reply: window %v, want 180000", m["context_window"])
	}
	rig.reply.Store(&nativeModelsReply{status: 401, body: []byte(`{"error":"expired"}`)})
	if code, _, _ := rig.list("user-one", "workspace-one", "rotated"); code != 401 {
		t.Errorf("unauthorized status %d, want 401 without cached success", code)
	}
}

func TestCodexModelsCacheSeparatesUsersAndWorkspaces(t *testing.T) {
	rig := newNativeModelsRig(t)
	accounts := []struct {
		user, workspace string
		window          int
	}{
		{"user-one", "workspace-one", 500000},
		{"user-one", "workspace-two", 300000},
		{"user-two", "workspace-two", 200000},
	}
	for _, a := range accounts {
		rig.backend(a.window)
		code, m, b := rig.list(a.user, a.workspace, "first")
		if code != 200 || m["context_window"] != float64(a.window) {
			t.Fatalf("fresh %s/%s: %d %s", a.user, a.workspace, code, b)
		}
		rig.saveCodexCache(b)
	}
	rig.reply.Store(&nativeModelsReply{slow: true})
	for _, a := range accounts {
		code, m, _ := rig.list(a.user, a.workspace, "rotated")
		if code != 200 || m["context_window"] != float64(a.window) {
			t.Errorf("cached %s/%s: window %v, want %d (status %d)", a.user, a.workspace, m["context_window"], a.window, code)
		}
	}
}
