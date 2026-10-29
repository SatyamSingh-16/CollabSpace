package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters: the OWASP Password Storage Cheat Sheet's minimum
// recommendation (19 MiB, 2 iterations, 1 lane). Each hash costs ~19 MiB of
// memory, which is what makes GPU guessing expensive. The parameters are
// stored in every hash, so they can be raised later without breaking
// existing passwords.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonKeyLen    = 32
	argonSaltLen   = 16
)

var errMalformedHash = errors.New("auth: malformed password hash")

// HashPassword returns a PHC-format string:
// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> (base64, no padding).
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword reports whether password matches encoded, using the
// parameters stored in encoded and a constant-time comparison.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errMalformedHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errMalformedHash
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, errMalformedHash
	}
	// The values come from the database, but argon2 panics on t=0 or p=0,
	// and an unbounded m would let one bad row exhaust memory (Week 5 review
	// R21). Accept a range around what HashPassword writes.
	if time < 1 || time > 10 || threads < 1 || threads > 16 || memory < 8*uint32(threads) || memory > 256*1024 {
		return false, errMalformedHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil || len(salt) < 8 {
		return false, errMalformedHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) < 16 || len(want) > 64 {
		return false, errMalformedHash
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when a login names an unknown email, so the
// response takes as long as a real failed login and doesn't reveal whether
// the account exists.
var dummyHash = func() string {
	h, err := HashPassword("not-a-real-password")
	if err != nil {
		panic(err)
	}
	return h
}()
