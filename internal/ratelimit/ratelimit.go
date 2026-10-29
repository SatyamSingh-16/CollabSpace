// Package ratelimit is a small in-memory token-bucket limiter keyed by
// string (client IP, account email). It protects the expensive login and
// registration endpoints.
//
// It is per process: with several server instances each has its own
// buckets, so the effective limit is multiplied by the instance count.
package ratelimit

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Rule allows Burst requests at once, refilled at Burst per Window.
// The zero Rule means "no limit".
type Rule struct {
	Burst  int
	Window time.Duration
}

func (r Rule) Disabled() bool { return r.Burst <= 0 || r.Window <= 0 }

func (r Rule) String() string {
	if r.Disabled() {
		return "off"
	}
	return fmt.Sprintf("%d/%s", r.Burst, r.Window)
}

// ParseRule reads "N/duration" (e.g. "10/1m", "5/1h") or "off".
func ParseRule(s string) (Rule, error) {
	s = strings.TrimSpace(s)
	if s == "off" {
		return Rule{}, nil
	}
	n, d, ok := strings.Cut(s, "/")
	burst, err1 := strconv.Atoi(n)
	window, err2 := time.ParseDuration(d)
	if !ok || err1 != nil || err2 != nil || burst <= 0 || window <= 0 {
		return Rule{}, fmt.Errorf("want N/duration like 10/1m, or off; got %q", s)
	}
	// One token per Window/Burst. If that rounds to (near) zero the bucket
	// math divides by zero and every request is denied (Week 5 review R20).
	if window/time.Duration(burst) < time.Millisecond {
		return Rule{}, fmt.Errorf("%q refills faster than one token per millisecond; use a longer window", s)
	}
	return Rule{Burst: burst, Window: window}, nil
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is safe for concurrent use. Memory is bounded by maxKeys: when
// full, idle buckets are swept (at most once per refill interval), and if
// that frees nothing, one arbitrary bucket is evicted. Eviction "forgives"
// that key, which is better than the alternative, refusing every new
// client (Week 3 review: a full cap must not become a lockout for all).
type Limiter struct {
	rule     Rule
	interval time.Duration // time to earn one token
	maxKeys  int
	now      func() time.Time

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

// New returns a limiter, or nil for a disabled rule. A nil *Limiter allows
// everything.
func New(rule Rule, maxKeys int) *Limiter {
	if rule.Disabled() {
		return nil
	}
	return &Limiter{
		rule:     rule,
		interval: rule.Window / time.Duration(rule.Burst),
		maxKeys:  maxKeys,
		now:      time.Now,
		buckets:  make(map[string]*bucket),
	}
}

// Allow spends one token for key. When none is left it reports how long
// until the next one.
func (l *Limiter) Allow(key string) (ok bool, retryAfter time.Duration) {
	if l == nil {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	b, found := l.buckets[key]
	if !found {
		if len(l.buckets) >= l.maxKeys && now.Sub(l.lastSweep) >= l.interval {
			l.sweep(now)
			l.lastSweep = now
		}
		if len(l.buckets) >= l.maxKeys {
			for k := range l.buckets { // map order is unspecified: an arbitrary key
				delete(l.buckets, k)
				break
			}
		}
		b = &bucket{tokens: float64(l.rule.Burst), last: now}
		l.buckets[key] = b
	}

	b.tokens = math.Min(float64(l.rule.Burst), b.tokens+float64(now.Sub(b.last))/float64(l.interval))
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) * float64(l.interval))
}

// sweep forgets buckets that have refilled completely: they behave exactly
// like a new key, so dropping them loses nothing.
func (l *Limiter) sweep(now time.Time) {
	full := time.Duration(l.rule.Burst) * l.interval
	for k, b := range l.buckets {
		if now.Sub(b.last) >= full {
			delete(l.buckets, k)
		}
	}
}

// Len reports how many keys are tracked (for tests and diagnostics).
func (l *Limiter) Len() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// ClientIP returns the key for the client behind r.
// By default it is the TCP
// peer address: headers like X-Forwarded-For are set by the client and can't
// be trusted. Only when the server sits behind a proxy that overwrites
// trustedHeader (e.g. Nginx's X-Real-IP) is that header used. IPv6
// addresses are reduced to their /64, because one client typically controls
// a whole /64 and could otherwise rotate addresses freely.
func ClientIP(r *http.Request, trustedHeader string) string {
	raw := ""
	if trustedHeader != "" {
		raw = r.Header.Get(trustedHeader)
		// A list (X-Forwarded-For: client, proxy1): the rightmost entry is
		// the one added by the proxy we trust; earlier ones are client-made.
		if i := strings.LastIndex(raw, ","); i >= 0 {
			raw = raw[i+1:]
		}
		raw = strings.TrimSpace(raw)
	}
	addr, err := netip.ParseAddr(raw)
	if raw == "" || err != nil {
		host, _, splitErr := net.SplitHostPort(r.RemoteAddr)
		if splitErr != nil {
			host = r.RemoteAddr
		}
		if addr, err = netip.ParseAddr(host); err != nil {
			return "unknown"
		}
	}
	addr = addr.Unmap()
	if addr.Is6() {
		prefix, _ := addr.Prefix(64)
		return prefix.String()
	}
	return addr.String()
}

// RetryAfterSeconds rounds up, for the Retry-After header.
func RetryAfterSeconds(d time.Duration) string {
	return strconv.Itoa(int(math.Ceil(d.Seconds())))
}
