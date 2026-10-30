package auth

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashRoundTrip(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected format: %s", h)
	}
	if strings.Contains(h, "correct horse") {
		t.Fatal("hash contains the password")
	}
	if ok, err := VerifyPassword("correct horse battery staple", h); err != nil || !ok {
		t.Fatalf("right password: ok=%v err=%v", ok, err)
	}
	if ok, err := VerifyPassword("correct horse battery stapl", h); err != nil || ok {
		t.Fatalf("wrong password: ok=%v err=%v", ok, err)
	}
}

func TestPasswordHashesAreSalted(t *testing.T) {
	a, _ := HashPassword("same password")
	b, _ := HashPassword("same password")
	if a == b {
		t.Fatal("two hashes of the same password are identical: no random salt")
	}
}

func TestVerifyRejectsMalformedHashes(t *testing.T) {
	for _, h := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA", "$argon2id$v=18$m=1,t=1,p=1$c2FsdA$aGFzaA", "$argon2id$v=19$m=x$c2FsdA$aGFzaA", "$argon2id$v=19$m=1,t=1,p=1$!!$aGFzaA"} {
		if _, err := VerifyPassword("x", h); err == nil {
			t.Errorf("%q: expected an error", h)
		}
	}
}

func TestNormalizeEmail(t *testing.T) {
	good := map[string]string{
		"  Alice@Example.COM ":     "alice@example.com",
		"bob+tag@mail.example.org": "bob+tag@mail.example.org",
	}
	for in, want := range good {
		if got, err := NormalizeEmail(in); err != nil || got != want {
			t.Errorf("%q → %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "a", "no-at-sign", "a@b", "Alice <alice@example.com>", "a@@example.com", strings.Repeat("a", 250) + "@example.com"} {
		if _, err := NormalizeEmail(bad); err == nil {
			t.Errorf("%q: expected a validation error", bad)
		}
	}
}

func TestTokensAreRandomAndOnlyTheHashIsDerived(t *testing.T) {
	t1, h1, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	t2, _, _ := newToken()
	if t1 == t2 || len(h1) != 32 {
		t.Fatalf("tokens %q %q, hash len %d", t1, t2, len(h1))
	}
	if string(hashToken(t1)) != string(h1) {
		t.Fatal("hashToken is not deterministic")
	}
}

// The hashing semaphore: when every slot is busy, a request waits, and gives
// up when its context ends instead of piling up more 19 MiB computations.
func TestHashSlotsBoundConcurrentHashing(t *testing.T) {
	s := &Service{hashSlots: make(chan struct{}, 1)}
	s.hashSlots <- struct{}{} // the only slot is taken
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	ran := false
	if err := s.withHashSlot(ctx, func() { ran = true }); err == nil || ran {
		t.Fatalf("err %v, ran %v; want a context error without running", err, ran)
	}
	<-s.hashSlots // slot released
	if err := s.withHashSlot(context.Background(), func() { ran = true }); err != nil || !ran {
		t.Fatalf("with a free slot: err %v, ran %v", err, ran)
	}
	if len(s.hashSlots) != 0 {
		t.Fatal("slot not released after use")
	}
}

func TestCookieConfig(t *testing.T) {
	// 1. Secure without domain uses __Host- prefix
	c1 := CookieConfig{Secure: true}
	if c1.Name() != "__Host-collabspace_session" {
		t.Fatalf("expected __Host-collabspace_session, got %s", c1.Name())
	}

	// 2. Insecure without domain uses collabspace_session
	c2 := CookieConfig{Secure: false}
	if c2.Name() != "collabspace_session" {
		t.Fatalf("expected collabspace_session, got %s", c2.Name())
	}

	// 3. Secure with domain does NOT use __Host- prefix (forbade by RFC 6265bis)
	c3 := CookieConfig{Secure: true, Domain: ".example.com"}
	if c3.Name() != "collabspace_session" {
		t.Fatalf("expected collabspace_session with domain, got %s", c3.Name())
	}
}
