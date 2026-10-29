package auth

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Week 5 review R21: argon2 panics on t=0 or p=0, and m was unbounded.
func TestVerifyRejectsOutOfRangeParameters(t *testing.T) {
	good, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	// Reuse a real salt and hash; only the parameters change.
	salt, sum := partsOf(good)
	for _, params := range []string{
		"m=19456,t=0,p=1",      // panicked: rounds too small
		"m=19456,t=2,p=0",      // panicked: parallelism too low
		"m=4194304,t=2,p=1",    // 4 GiB per verification
		"m=19456,t=100000,p=1", // minutes of CPU
		"m=4,t=2,p=1",          // below argon2's minimum for p=1
	} {
		encoded := "$argon2id$v=19$" + params + "$" + salt + "$" + sum
		ok, err := VerifyPassword("correct horse", encoded)
		if ok || !errors.Is(err, errMalformedHash) {
			t.Errorf("%s: ok=%v err=%v, want errMalformedHash", params, ok, err)
		}
	}
	if ok, err := VerifyPassword("correct horse", good); !ok || err != nil {
		t.Fatalf("the real hash no longer verifies: %v %v", ok, err)
	}
}

func partsOf(encoded string) (salt, sum string) {
	var fields []string
	start := 0
	for i := range len(encoded) {
		if encoded[i] == '$' {
			fields = append(fields, encoded[start:i])
			start = i + 1
		}
	}
	fields = append(fields, encoded[start:])
	return fields[4], fields[5]
}

// Week 5 review R9: waiting for a hashing slot had no bound except the client
// leaving; no server timeout cancels a request's context.
func TestHashSlotWaitIsBounded(t *testing.T) {
	s := NewService(nil, time.Hour)
	s.hashWait = 50 * time.Millisecond
	for range cap(s.hashSlots) { // a flood holds every slot
		s.hashSlots <- struct{}{}
	}
	done := make(chan error, 1)
	go func() { done <- s.withHashSlot(context.Background(), func() { t.Error("ran without a slot") }) }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("err %v, want ErrBusy", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("still waiting for a hashing slot after 2s")
	}
}
