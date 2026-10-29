package app

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"collabspace/internal/collab"
	"collabspace/internal/config"
)

// Week 4: presence through the real stack (sessions, membership table,
// revocation hooks). internal/collab tests the room logic in detail.

func (s *server) registerNamed(t *testing.T, name string) account {
	t.Helper()
	email := uniqueEmail()
	r := s.do("POST", "/api/auth/register", map[string]string{"email": email, "password": "password-123", "display_name": name}, nil)
	if r.status != http.StatusCreated || r.session() == nil {
		t.Fatalf("register: %d %s", r.status, r.raw)
	}
	return account{id: r.field("user", "id").(string), email: email, cookie: r.session()}
}

// nextPresence skips other frames until a presence frame arrives and
// returns it as "name:role" entries in the server's order.
func nextPresence(t *testing.T, ws *websocket.Conn) []string {
	t.Helper()
	for {
		m, err := wsReadAny(t, ws)
		if err != nil {
			t.Fatalf("waiting for presence: %v", err)
		}
		if m.Type != "presence" {
			continue
		}
		var out []string
		for _, u := range m.Users {
			out = append(out, u.DisplayName+":"+u.Role)
		}
		return out
	}
}

func expectPresenceOf(t *testing.T, ws *websocket.Conn, want ...string) {
	t.Helper()
	got := nextPresence(t, ws)
	// The server sorts by user ID; compare as sets of entries.
	if len(got) != len(want) || !containsAll(got, want) {
		t.Fatalf("presence %v, want %v", got, want)
	}
}

func containsAll(have, want []string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			found = found || h == w
		}
		if !found {
			return false
		}
	}
	return true
}

// Identity, name and role come from the session and the membership table.
// A join frame carrying someone else's identity changes nothing, and the
// frame never includes the email address.
func TestPresenceUsesServerSideIdentity(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.registerNamed(t, "Olivia"), s.registerNamed(t, "Bob")
	doc := s.createDoc(t, owner, "presence")
	s.share(t, owner, doc, bob.email, "editor")
	ownerWS, _ := s.joinWS(t, doc, owner)
	expectPresenceOf(t, ownerWS, "Olivia:owner")

	ws, resp, err := s.dialWS(doc, bob.cookie, origin)
	if err != nil {
		t.Fatalf("dial: %v %v", err, resp)
	}
	t.Cleanup(func() { ws.Close() })
	_ = ws.WriteJSON(map[string]any{
		"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0,
		// Not part of the protocol; must be ignored.
		"user_id": owner.id, "display_name": "Mallory", "role": "owner",
	})
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var raw []byte
	for {
		_, b, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), `"presence"`) {
			raw = b
			break
		}
	}
	for _, leak := range []string{bob.email, owner.email, "Mallory", bob.cookie.Value} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("presence frame contains %q: %s", leak, raw)
		}
	}
	if !strings.Contains(string(raw), `"user_id":"`+bob.id+`","display_name":"Bob","role":"editor"`) {
		t.Fatalf("bob's entry missing or wrong: %s", raw)
	}
	expectPresenceOf(t, ownerWS, "Olivia:owner", "Bob:editor")
}

// Logout closes only that session's sockets; the user stays listed while
// another session is open. Session expiry removes the user too.
func TestPresenceAfterLogoutAndSessionExpiry(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.SessionTTL = 3 * time.Second })
	bob := s.registerNamed(t, "Bob")                          // "laptop" session
	bobPhone := login(s, bob.email, "password-123").session() // second session
	// Fixed spacing so the owner's session (created later) outlives both of
	// bob's by a clear margin; the test watches bob's expiry from it.
	time.Sleep(time.Second)
	owner := s.registerNamed(t, "Olivia")
	doc := s.createDoc(t, owner, "presence")
	s.share(t, owner, doc, bob.email, "editor")
	ownerWS, _ := s.joinWS(t, doc, owner)
	expectPresenceOf(t, ownerWS, "Olivia:owner")

	laptopWS, _ := s.joinWS(t, doc, bob)
	expectPresenceOf(t, ownerWS, "Olivia:owner", "Bob:editor")
	phoneWS, _ := s.joinWS(t, doc, account{id: bob.id, email: bob.email, cookie: bobPhone})

	// The laptop's session is logged out; the phone keeps bob present.
	if r := s.do("POST", "/api/auth/logout", nil, bob.cookie); r.status != 204 {
		t.Fatalf("logout: %d", r.status)
	}
	expectClose(t, laptopWS, collab.CloseUnauthenticated)
	// The phone's session then expires, before the owner's.
	expectClose(t, phoneWS, collab.CloseUnauthenticated)
	// The owner's next presence frame is the one without bob: nothing was
	// sent when the laptop left, because bob was still present.
	expectPresenceOf(t, ownerWS, "Olivia:owner")
}

// Removal and role changes through the members API.
func TestPresenceAfterMemberRemovalAndRoleChangeViaAPI(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.registerNamed(t, "Olivia"), s.registerNamed(t, "Bob")
	doc := s.createDoc(t, owner, "presence")
	s.share(t, owner, doc, bob.email, "editor")
	ownerWS, _ := s.joinWS(t, doc, owner)
	expectPresenceOf(t, ownerWS, "Olivia:owner")
	bobWS, _ := s.joinWS(t, doc, bob)
	expectPresenceOf(t, ownerWS, "Olivia:owner", "Bob:editor")

	s.share(t, owner, doc, bob.email, "viewer")
	expectClose(t, bobWS, collab.CloseResyncRequired)
	expectPresenceOf(t, ownerWS, "Olivia:owner")
	bobWS, _ = s.joinWS(t, doc, bob) // the client's automatic reconnect
	expectPresenceOf(t, ownerWS, "Olivia:owner", "Bob:viewer")

	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+bob.id, nil, owner.cookie); r.status != 204 {
		t.Fatalf("remove: %d %s", r.status, r.raw)
	}
	expectClose(t, bobWS, collab.CloseForbidden)
	expectPresenceOf(t, ownerWS, "Olivia:owner")
}
