package ratelimit

import (
	"net/http/httptest"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }
func limiter(r Rule, max int, c *clock) *Limiter {
	l := New(r, max)
	l.now = c.now
	return l
}

func TestBurstThenRefill(t *testing.T) {
	c := &clock{time.Unix(0, 0)}
	l := limiter(Rule{Burst: 3, Window: 3 * time.Minute}, 100, c) // 1 token per minute
	for i := range 3 {
		if ok, _ := l.Allow("k"); !ok {
			t.Fatalf("request %d within burst refused", i+1)
		}
	}
	ok, retry := l.Allow("k")
	if ok || retry != time.Minute {
		t.Fatalf("4th: ok=%v retry=%v, want refused with 1m", ok, retry)
	}
	c.advance(30 * time.Second)
	if ok, retry := l.Allow("k"); ok || retry != 30*time.Second {
		t.Fatalf("after 30s: ok=%v retry=%v, want refused with 30s", ok, retry)
	}
	c.advance(30 * time.Second)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("after a full interval: refused")
	}
	if ok, _ := l.Allow("other"); !ok {
		t.Fatal("keys must be independent")
	}
}

func TestTokensDoNotAccumulateBeyondBurst(t *testing.T) {
	c := &clock{time.Unix(0, 0)}
	l := limiter(Rule{Burst: 2, Window: time.Minute}, 100, c)
	l.Allow("k")
	c.advance(24 * time.Hour)
	allowed := 0
	for range 5 {
		if ok, _ := l.Allow("k"); ok {
			allowed++
		}
	}
	if allowed != 2 {
		t.Fatalf("allowed %d after a long idle period, want burst 2", allowed)
	}
}

// A full key table must not lock out new clients (Week 3 review #5): one
// arbitrary bucket is evicted instead, and memory stays at the cap.
func TestKeyCountIsBoundedWithoutLockingOutNewKeys(t *testing.T) {
	c := &clock{time.Unix(0, 0)}
	l := limiter(Rule{Burst: 1, Window: time.Minute}, 3, c)
	for _, k := range []string{"a", "b", "c"} {
		l.Allow(k)
	}
	for _, k := range []string{"d", "e", "f", "g"} {
		if ok, _ := l.Allow(k); !ok || l.Len() != 3 {
			t.Fatalf("new key %s while full: ok=%v len=%d, want allowed and 3", k, ok, l.Len())
		}
	}
	c.advance(time.Minute) // everything has fully refilled: idle
	if ok, _ := l.Allow("h"); !ok || l.Len() != 1 {
		t.Fatalf("after idle sweep: ok=%v len=%d, want allowed and 1", ok, l.Len())
	}
}

func TestDisabledRuleAllowsEverything(t *testing.T) {
	var l *Limiter = New(Rule{}, 10)
	for range 100 {
		if ok, _ := l.Allow("k"); !ok {
			t.Fatal("disabled limiter refused")
		}
	}
}

func TestParseRule(t *testing.T) {
	if r, err := ParseRule("10/1m"); err != nil || r.Burst != 10 || r.Window != time.Minute {
		t.Fatalf("10/1m → %+v %v", r, err)
	}
	if r, err := ParseRule("off"); err != nil || !r.Disabled() {
		t.Fatalf("off → %+v %v", r, err)
	}
	for _, bad := range []string{"", "10", "0/1m", "-1/1m", "10/0s", "ten/1m", "10/forever"} {
		if _, err := ParseRule(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestClientIPIgnoresUntrustedHeaders(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "203.0.113.7:51234"
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	r.Header.Set("X-Real-IP", "198.51.100.2")
	if got := ClientIP(r, ""); got != "203.0.113.7" {
		t.Fatalf("no trusted header: %s, want the TCP peer", got)
	}
	if got := ClientIP(r, "X-Real-IP"); got != "198.51.100.2" {
		t.Fatalf("trusted X-Real-IP: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 198.51.100.3") // client-made, then our proxy
	if got := ClientIP(r, "X-Forwarded-For"); got != "198.51.100.3" {
		t.Fatalf("trusted list header: %s, want the rightmost entry", got)
	}
	r.Header.Set("X-Real-IP", "not-an-ip")
	if got := ClientIP(r, "X-Real-IP"); got != "203.0.113.7" {
		t.Fatalf("garbage trusted header: %s, want fallback to the peer", got)
	}
}

func TestClientIPGroupsIPv6By64(t *testing.T) {
	a := httptest.NewRequest("POST", "/", nil)
	a.RemoteAddr = "[2001:db8:1:2:aaaa::1]:443"
	b := httptest.NewRequest("POST", "/", nil)
	b.RemoteAddr = "[2001:db8:1:2:bbbb::9]:443"
	if ClientIP(a, "") != ClientIP(b, "") || ClientIP(a, "") != "2001:db8:1:2::/64" {
		t.Fatalf("%s vs %s", ClientIP(a, ""), ClientIP(b, ""))
	}
	v4mapped := httptest.NewRequest("POST", "/", nil)
	v4mapped.RemoteAddr = "[::ffff:192.0.2.5]:80"
	if got := ClientIP(v4mapped, ""); got != "192.0.2.5" {
		t.Fatalf("v4-mapped: %s", got)
	}
}

// Week 5 review R20: a rule whose refill interval rounds to zero used to deny
// every request (0/0 = NaN).
func TestParseRuleRejectsSubMillisecondRefill(t *testing.T) {
	if _, err := ParseRule("2000000000/1s"); err == nil {
		t.Fatal("accepted a rule refilling every 0.5ns")
	}
	if _, err := ParseRule("1000/1s"); err != nil {
		t.Fatalf("1000/1s: %v", err)
	}
}
