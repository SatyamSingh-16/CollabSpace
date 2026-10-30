package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL":    "postgres:///x",
		"ALLOWED_ORIGINS": "https://app.example.com, http://localhost:5173",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.CookieSecure {
		t.Error("COOKIE_SECURE must default to true")
	}
	if c.SessionTTL != 7*24*time.Hour || c.HTTPAddr != "127.0.0.1:8080" || !c.MigrateOnStart {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[1] != "http://localhost:5173" {
		t.Errorf("origins %v", c.AllowedOrigins)
	}
}

func TestLoadReportsEveryProblem(t *testing.T) {
	_, err := Load(env(map[string]string{
		"ALLOWED_ORIGINS": "https://ok.example, https://bad.example/path, *",
		"COOKIE_SECURE":   "maybe",
		"SESSION_TTL":     "1m",
		"LOG_FORMAT":      "xml",
	}))
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{"DATABASE_URL is required", "bad.example/path", `"*"`, "COOKIE_SECURE", "SESSION_TTL", "LOG_FORMAT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}

func TestOriginsAreRequired(t *testing.T) {
	_, err := Load(env(map[string]string{"DATABASE_URL": "postgres:///x"}))
	if err == nil || !strings.Contains(err.Error(), "ALLOWED_ORIGINS is required") {
		t.Fatalf("got %v", err)
	}
}

func TestOriginListMustNotBeEmpty(t *testing.T) {
	_, err := Load(env(map[string]string{"DATABASE_URL": "postgres:///x", "ALLOWED_ORIGINS": " , ,"}))
	if err == nil || !strings.Contains(err.Error(), "lists no origins") {
		t.Fatalf("got %v", err)
	}
}

func TestCookieSecureCanBeDisabledExplicitly(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL": "postgres:///x", "ALLOWED_ORIGINS": "http://localhost:5173", "COOKIE_SECURE": "false",
	}))
	if err != nil || c.CookieSecure {
		t.Fatalf("CookieSecure=%v, err=%v", c.CookieSecure, err)
	}
}

func TestRateLimitDefaultsAndOverrides(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres:///x", "ALLOWED_ORIGINS": "http://localhost:5173"}
	c, err := Load(env(base))
	if err != nil {
		t.Fatal(err)
	}
	got := []string{c.RateLoginPerIP.String(), c.RateLoginPerAccountIP.String(), c.RateLoginPerAccount.String(), c.RateRegisterPerIP.String(), c.RateSharePerUser.String()}
	want := []string{"30/10m0s", "10/10m0s", "50/10m0s", "10/1h0m0s", "30/10m0s"}
	if strings.Join(got, " ") != strings.Join(want, " ") || c.TrustedProxyHeader != "" {
		t.Fatalf("defaults: %v %q, want %v", got, c.TrustedProxyHeader, want)
	}
	base["RATE_LIMIT_REGISTER_PER_IP"] = "off"
	base["RATE_LIMIT_LOGIN_PER_IP"] = "lots"
	if _, err := Load(env(base)); err == nil || !strings.Contains(err.Error(), "RATE_LIMIT_LOGIN_PER_IP") {
		t.Fatalf("bad rule accepted: %v", err)
	}
	delete(base, "RATE_LIMIT_LOGIN_PER_IP")
	if c, err := Load(env(base)); err != nil || !c.RateRegisterPerIP.Disabled() {
		t.Fatalf("off: %v %v", c.RateRegisterPerIP, err)
	}
}

// Week 5 review D1: COOKIE_SECURE=false outside local development.
func TestInsecureCookieOnlyForLocalOrigins(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres:///x", "COOKIE_SECURE": "false"}
	for origins, ok := range map[string]bool{
		"http://localhost:5173,http://127.0.0.1:5173":  true,
		"http://[::1]:5173":                            true,
		"https://app.example.com":                      false,
		"http://localhost:5173,http://app.example.com": false,
		"http://192.168.1.20:5173":                     false,
	} {
		vars := map[string]string{"ALLOWED_ORIGINS": origins}
		for k, v := range base {
			vars[k] = v
		}
		_, err := Load(env(vars))
		if (err == nil) != ok {
			t.Errorf("%s: err %v, want ok=%v", origins, err, ok)
		}
	}
	// Secure cookies are fine with any valid origin.
	secure := map[string]string{"DATABASE_URL": "postgres:///x", "ALLOWED_ORIGINS": "https://app.example.com"}
	if _, err := Load(env(secure)); err != nil {
		t.Fatal(err)
	}
}

// Week 6: the database URL (with its password) can come from a mounted
// secret file instead of the environment.
func TestDatabaseURLFromFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/database_url"
	if err := os.WriteFile(path, []byte("postgres://app:s3cret@db/collabspace\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := map[string]string{"ALLOWED_ORIGINS": "https://app.example.com", "DATABASE_URL_FILE": path}
	c, err := Load(env(base))
	if err != nil || c.DatabaseURL != "postgres://app:s3cret@db/collabspace" {
		t.Fatalf("from file: %q %v", c.DatabaseURL, err)
	}
	base["DATABASE_URL"] = "postgres:///other"
	if _, err := Load(env(base)); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("both set: %v", err)
	}
	delete(base, "DATABASE_URL")
	base["DATABASE_URL_FILE"] = dir + "/missing"
	_, err = Load(env(base))
	if err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("missing file: %v", err)
	}
}

func TestPortEnvFallback(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL":    "postgres:///x",
		"ALLOWED_ORIGINS": "https://app.example.com",
		"PORT":            "10000",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":10000" {
		t.Fatalf("expected :10000, got %s", c.HTTPAddr)
	}

	// HTTP_ADDR takes priority over PORT if both provided
	c2, err := Load(env(map[string]string{
		"DATABASE_URL":    "postgres:///x",
		"ALLOWED_ORIGINS": "https://app.example.com",
		"PORT":            "10000",
		"HTTP_ADDR":       "0.0.0.0:8080",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c2.HTTPAddr != "0.0.0.0:8080" {
		t.Fatalf("expected 0.0.0.0:8080, got %s", c2.HTTPAddr)
	}
}
