package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func parseList(raw string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		p := strings.ToLower(strings.TrimSpace(part))
		if p != "" {
			out[p] = true
		}
	}
	return out
}

func status(kind string, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = kind
	b, _ := json.Marshal(fields)
	fmt.Printf("@@ahcc-ts %s\n", string(b))
}

func main() {
	authKey := strings.TrimSpace(os.Getenv("AHCC_TS_AUTHKEY"))
	hostname := env("AHCC_TS_HOSTNAME", "ahcc")
	upstream := env("AHCC_TS_UPSTREAM", "http://127.0.0.1:8080")
	stateDir := env("AHCC_TS_STATE", "./.tailscale")
	allowed := parseList(os.Getenv("AHCC_TS_ALLOWED"))

	if authKey == "" {
		if _, err := os.Stat(filepath.Join(stateDir, "tailscaled.state")); err != nil {
			status("error", map[string]any{"message": "AHCC_TS_AUTHKEY is required"})
			os.Exit(1)
		}
	}
	target, err := url.Parse(upstream)
	if err != nil {
		status("error", map[string]any{"message": "bad AHCC_TS_UPSTREAM: " + err.Error()})
		os.Exit(1)
	}

	srv := &tsnet.Server{
		Hostname: hostname,
		Dir:      stateDir,
		AuthKey:  authKey,
	}
	defer srv.Close()

	shutdown := func() {
		srv.Close()
		os.Exit(0)
	}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		shutdown()
	}()
	go func() {
		io.Copy(io.Discard, os.Stdin)
		shutdown()
	}()

	status("connecting", map[string]any{"hostname": hostname})

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := srv.Up(ctx); err != nil {
		status("error", map[string]any{"message": "tailnet join failed: " + err.Error()})
		os.Exit(1)
	}

	lc, err := srv.LocalClient()
	if err != nil {
		status("error", map[string]any{"message": "local client: " + err.Error()})
		os.Exit(1)
	}

	if st, err := lc.StatusWithoutPeers(context.Background()); err == nil && st.Self != nil {
		status("running", map[string]any{
			"dnsName": strings.TrimSuffix(st.Self.DNSName, "."),
			"tailnet": st.CurrentTailnet.Name,
			"allowed": len(allowed),
		})
	} else {
		status("running", map[string]any{"allowed": len(allowed)})
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || who.UserProfile == nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		login := strings.ToLower(who.UserProfile.LoginName)
		if len(allowed) == 0 || !allowed[login] {
			http.Error(w, "not authorized for AHCC", http.StatusForbidden)
			return
		}
		r.Host = target.Host
		proxy.ServeHTTP(w, r)
	})

	running := func(https bool) {
		fields := map[string]any{"allowed": len(allowed), "https": https}
		if ip4, _ := srv.TailscaleIPs(); ip4.IsValid() {
			fields["ip"] = ip4.String()
		}
		if st, serr := lc.StatusWithoutPeers(context.Background()); serr == nil && st.Self != nil {
			fields["dnsName"] = strings.TrimSuffix(st.Self.DNSName, ".")
			fields["tailnet"] = st.CurrentTailnet.Name
		}
		status("running", fields)
	}

	plain, err := srv.Listen("tcp", ":80")
	if err != nil {
		status("error", map[string]any{"message": "listen 80: " + err.Error()})
		os.Exit(1)
	}
	go func() {
		if err := http.Serve(plain, handler); err != nil {
			status("error", map[string]any{"message": "serve: " + err.Error()})
			os.Exit(1)
		}
	}()

	ln, err := srv.ListenTLS("tcp", ":443")
	for err != nil {
		running(false)
		time.Sleep(15 * time.Second)
		ln, err = srv.ListenTLS("tcp", ":443")
	}
	running(true)
	defer ln.Close()

	if err := http.Serve(ln, handler); err != nil {
		status("error", map[string]any{"message": "serve: " + err.Error()})
		os.Exit(1)
	}
}
