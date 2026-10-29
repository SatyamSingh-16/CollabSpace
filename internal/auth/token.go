package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// A session token is 32 random bytes (256 bits) sent to the browser as
// base64url in a cookie. The database stores only SHA-256(token): a leaked
// sessions table can't be replayed as cookies. A fast hash is enough here
// because, unlike a password, the token has full entropy and can't be
// guessed by trying likely values.
const tokenBytes = 32

func newToken() (token string, hash []byte, err error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, hashToken(token), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
