package collab

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"collabspace/internal/store"
)

// --- helpers ---

type tab struct {
	*client
	name string
}

// open dials as user with a fresh client ID (a new browser tab). session is
// optional; it lets a test revoke this connection's session.
func (e *env) open(doc, user uuid.UUID, name string, role Role, session string) *tab {
	e.t.Helper()
	h := http.Header{}
	h.Set("X-Test-Name", name)
	if session != "" {
		h.Set("X-Test-Session", session)
	}
	c, _, err := e.dialAs(doc, user, uuid.New(), role, h)
	if err != nil {
		e.t.Fatalf("dial %s: %v", name, err)
	}
	e.t.Cleanup(func() { c.ws.Close() })
	return &tab{client: c, name: name}
}

// reopen reconnects old's tab: same user, client ID and name.
func (e *env) reopen(doc uuid.UUID, old *tab, role Role) *tab {
	e.t.Helper()
	c, _, err := e.dialAs(doc, old.user, old.clientID, role, http.Header{"X-Test-Name": {old.name}})
	if err != nil {
		e.t.Fatalf("redial %s: %v", old.name, err)
	}
	e.t.Cleanup(func() { c.ws.Close() })
	return &tab{client: c, name: old.name}
}

func userIDs(users []presenceUser) []uuid.UUID {
	ids := make([]uuid.UUID, len(users))
	for i, u := range users {
		ids[i] = u.UserID
	}
	return ids
}

func sortedIDs(ids ...uuid.UUID) []uuid.UUID {
	return slices.SortedFunc(slices.Values(ids), func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
}

// expectPresence checks the next presence list c was sent is exactly want
// (in the server's order: sorted by user ID).
func expectPresence(t *testing.T, c *client, want ...uuid.UUID) []presenceUser {
	t.Helper()
	users, err := c.nextPresence()
	if err != nil {
		t.Fatalf("waiting for presence %v: %v", want, err)
	}
	if got := userIDs(users); !slices.Equal(got, sortedIDs(want...)) {
		t.Fatalf("presence %v, want %v", got, sortedIDs(want...))
	}
	return users
}

// probe proves that no presence frame was sent to watcher since its last
// one: a new user joins, and watcher's NEXT presence must be its previous
// list plus the probe. Any frame sent in between (e.g. for a tab closing
// while its user stays) would arrive first and fail the check. The probe
// then leaves, and watcher must see exactly before again.
func (e *env) probe(t *testing.T, doc uuid.UUID, watcher *client, before ...uuid.UUID) {
	t.Helper()
	p := e.open(doc, uuid.New(), "Probe", RoleViewer, "")
	p.mustSync(t, 0)
	expectPresence(t, watcher, append(slices.Clone(before), p.user)...)
	p.ws.Close()
	expectPresence(t, watcher, before...)
}

// expectCloseReason is expectClose that also checks the reason text.
func (c *client) expectCloseReason(code int, reason string) error {
	for {
		_, err := c.readFrame()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) {
			return fmt.Errorf("connection ended without close frame: %v", err)
		}
		if ce.Code != code || ce.Text != reason {
			return fmt.Errorf("closed with %d %q, want %d %q", ce.Code, ce.Text, code, reason)
		}
		return nil
	}
}

// --- joins and leaves ---

func TestPresenceFirstUserJoins(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	alice := e.open(doc, uuid.New(), "Alice", RoleEditor, "")
	alice.mustSync(t, 0)
	users := expectPresence(t, alice.client, alice.user)
	if users[0].DisplayName != "Alice" || users[0].Role != RoleEditor {
		t.Fatalf("presence entry %+v", users[0])
	}
}

// The wire format carries the user ID, name and role, and nothing else:
// no session ID, client ID, connection ID or email.
func TestPresenceFrameContainsOnlyPublicFields(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	const session = "secret-session-id-0123456789"
	c := e.open(doc, uuid.New(), "Alice", RoleEditor, session)
	c.mustSync(t, 0)

	_ = c.ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, raw, err := c.ws.ReadMessage() // the frame right after synced
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if string(m["type"]) != `"presence"` || len(m) != 2 {
		t.Fatalf("frame %s", raw)
	}
	var users []map[string]any
	if err := json.Unmarshal(m["users"], &users); err != nil || len(users) != 1 {
		t.Fatalf("users %s: %v", m["users"], err)
	}
	want := map[string]any{"user_id": c.user.String(), "display_name": "Alice", "role": "editor"}
	if fmt.Sprint(users[0]) != fmt.Sprint(want) {
		t.Fatalf("entry %v, want exactly %v", users[0], want)
	}
	for _, secret := range []string{session, c.clientID.String()} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("presence frame leaks %q: %s", secret, raw)
		}
	}
}

func TestPresenceSecondUserJoinsAndLeaves(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	alice := e.open(doc, uuid.New(), "Alice", RoleEditor, "")
	alice.mustSync(t, 0)
	expectPresence(t, alice.client, alice.user)

	bob := e.open(doc, uuid.New(), "Bob", RoleViewer, "")
	bob.mustSync(t, 0)
	users := expectPresence(t, bob.client, alice.user, bob.user)
	expectPresence(t, alice.client, alice.user, bob.user)
	for _, u := range users {
		if u.UserID == bob.user && (u.DisplayName != "Bob" || u.Role != RoleViewer) {
			t.Fatalf("bob's entry %+v", u)
		}
	}

	// A clean close (close frame, then TCP close).
	_ = bob.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(CloseNormal, ""), time.Now().Add(time.Second))
	bob.ws.Close()
	expectPresence(t, alice.client, alice.user)
}

// One user, several tabs: listed once. Closing one tab sends nothing while
// another tab is open; closing the last removes the user.
func TestPresenceListsUsersNotConnections(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	aliceID := uuid.New()
	tab1 := e.open(doc, aliceID, "Alice", RoleEditor, "")
	tab1.mustSync(t, 0)
	expectPresence(t, tab1.client, aliceID)

	tab2 := e.open(doc, aliceID, "Alice", RoleEditor, "")
	tab2.mustSync(t, 0)
	expectPresence(t, tab2.client, aliceID) // the newcomer gets the current list

	bob := e.open(doc, uuid.New(), "Bob", RoleEditor, "")
	bob.mustSync(t, 0)
	expectPresence(t, bob.client, aliceID, bob.user)
	// tab1's next frame is the one for bob: tab2's join broadcast nothing.
	expectPresence(t, tab1.client, aliceID, bob.user)

	room := e.room(doc)
	tab1.ws.Close()
	eventually(t, "tab1 removed", func() bool { return room.memberCount() == 2 })
	e.probe(t, doc, bob.client, aliceID, bob.user) // no frame for tab1 closing

	tab2.ws.Close()
	expectPresence(t, bob.client, bob.user)
}

// --- disconnects and reconnects ---

func TestPresenceAbruptDisconnectAndReconnect(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	alice := e.open(doc, uuid.New(), "Alice", RoleEditor, "")
	bob := e.open(doc, uuid.New(), "Bob", RoleEditor, "")
	alice.mustSync(t, 0)
	bob.mustSync(t, 0)
	expectPresence(t, bob.client, alice.user, bob.user)

	// Drop TCP without a close frame; the server's read fails.
	alice.ws.UnderlyingConn().Close()
	expectPresence(t, bob.client, bob.user)

	again := e.reopen(doc, alice, RoleEditor) // same user, same client ID
	again.mustSync(t, 0)
	expectPresence(t, again.client, alice.user, bob.user)
	expectPresence(t, bob.client, alice.user, bob.user)
}

// A tab whose network dropped reconnects before the server has noticed (its
// read deadline is PongWait away). The new connection replaces the old one
// at once: no duplicate slot, no presence flicker for others. Another user
// presenting the same client_id replaces nothing.
func TestPresenceReconnectReplacesStaleConnection(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	alice := e.open(doc, uuid.New(), "Alice", RoleEditor, "")
	bob := e.open(doc, uuid.New(), "Bob", RoleEditor, "")
	alice.mustSync(t, 0)
	bob.mustSync(t, 0)
	expectPresence(t, bob.client, alice.user, bob.user)
	room := e.room(doc)

	// Same user, same client_id, while the old socket is still open.
	again := e.reopen(doc, alice, RoleEditor)
	again.mustSync(t, 0)
	if err := alice.expectCloseReason(CloseResyncRequired, closeReplaced); err != nil {
		t.Fatalf("old connection: %v", err)
	}
	if n := room.memberCount(); n != 2 {
		t.Fatalf("members %d, want 2 (old connection replaced)", n)
	}
	e.probe(t, doc, bob.client, alice.user, bob.user) // bob saw no change

	// A different user claiming alice's client_id doesn't close her.
	mallory, _, err := e.dialAs(doc, uuid.New(), alice.clientID, RoleEditor, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mallory.ws.Close() })
	mallory.mustSync(t, 0)
	if n := room.memberCount(); n != 3 {
		t.Fatalf("members %d, want 3: mallory must not replace alice", n)
	}
	expectPresence(t, bob.client, alice.user, bob.user, mallory.user)
}

// In a full room, a tab reconnecting over its own still-registered
// connection takes that connection's slot instead of being refused.
func TestReconnectIntoFullRoomReplacesOwnStaleConnection(t *testing.T) {
	cfg := testConfig()
	cfg.MaxRoomConns = 2
	e := newEnv(t, cfg)
	doc := e.newDoc()
	alice := e.open(doc, uuid.New(), "Alice", RoleEditor, "")
	bob := e.open(doc, uuid.New(), "Bob", RoleEditor, "")
	alice.mustSync(t, 0)
	bob.mustSync(t, 0)

	again := e.reopen(doc, alice, RoleEditor)
	if _, _, err := again.sync(0); err != nil {
		t.Fatalf("reconnect into a full room: %v", err)
	}
	if err := alice.expectCloseReason(CloseResyncRequired, closeReplaced); err != nil {
		t.Fatal(err)
	}
	// A different tab still can't get in.
	carol := e.open(doc, uuid.New(), "Carol", RoleEditor, "")
	_ = carol.join(0)
	if err := carol.expectClose(CloseRoomFull); err != nil {
		t.Fatal(err)
	}
}

// --- revocation ---

// Logout (RevokeSession) closes that session's connections. The user stays
// listed while another session still has the document open.
func TestPresenceAfterSessionRevocation(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	aliceID := uuid.New()
	laptop := e.open(doc, aliceID, "Alice", RoleEditor, "alice-laptop")
	phone := e.open(doc, aliceID, "Alice", RoleEditor, "alice-phone")
	bob := e.open(doc, uuid.New(), "Bob", RoleEditor, "bob-session")
	laptop.mustSync(t, 0)
	phone.mustSync(t, 0)
	bob.mustSync(t, 0)
	expectPresence(t, bob.client, aliceID, bob.user)
	room := e.room(doc)

	e.hub.RevokeSession("alice-laptop")
	if err := laptop.expectClose(CloseUnauthenticated); err != nil {
		t.Fatal(err)
	}
	eventually(t, "laptop removed", func() bool { return room.memberCount() == 2 })
	e.probe(t, doc, bob.client, aliceID, bob.user)

	e.hub.RevokeSession("alice-phone")
	if err := phone.expectClose(CloseUnauthenticated); err != nil {
		t.Fatal(err)
	}
	expectPresence(t, bob.client, bob.user)
}

// Removal closes the user's connections (4003) and drops them from
// presence. A role change closes them with 4008; on reconnect they appear
// again with the role the handshake read.
func TestPresenceAfterMemberRemovalAndRoleChange(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	aliceID := uuid.New()
	alice := e.open(doc, aliceID, "Alice", RoleEditor, "")
	owner := e.open(doc, uuid.New(), "Owner", RoleOwner, "")
	alice.mustSync(t, 0)
	owner.mustSync(t, 0)
	expectPresence(t, owner.client, aliceID, owner.user)

	e.hub.SetMemberRole(doc, aliceID, "")
	if err := alice.expectClose(CloseForbidden); err != nil {
		t.Fatal(err)
	}
	expectPresence(t, owner.client, owner.user)

	// Shared again as editor, then lowered to viewer.
	alice = e.open(doc, aliceID, "Alice", RoleEditor, "")
	alice.mustSync(t, 0)
	users := expectPresence(t, owner.client, aliceID, owner.user)
	if r := roleOf(users, aliceID); r != RoleEditor {
		t.Fatalf("alice listed as %q", r)
	}
	e.hub.SetMemberRole(doc, aliceID, RoleViewer)
	if err := alice.expectClose(CloseResyncRequired); err != nil {
		t.Fatal(err)
	}
	expectPresence(t, owner.client, owner.user)
	viewer := e.open(doc, aliceID, "Alice", RoleViewer, "") // the handshake's role
	viewer.mustSync(t, 0)
	users = expectPresence(t, owner.client, aliceID, owner.user)
	if r := roleOf(users, aliceID); r != RoleViewer {
		t.Fatalf("alice listed as %q after the change, want viewer", r)
	}
}

func roleOf(users []presenceUser, id uuid.UUID) Role {
	for _, u := range users {
		if u.UserID == id {
			return u.Role
		}
	}
	return ""
}

// --- room-level: backpressure, roles per user ---

// roomHarness joins connections straight into a room without sockets, so a
// test controls exactly which queues are drained.
type roomHarness struct {
	t   *testing.T
	hub *Hub
	doc uuid.UUID
}

func newRoomHarness(t *testing.T) *roomHarness {
	hub := NewHub(store.New(testPool), testConfig(), slog.New(slog.DiscardHandler))
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	doc := uuid.New()
	if err := store.New(testPool).CreateDocument(context.Background(), doc, t.Name()); err != nil {
		t.Fatal(err)
	}
	return &roomHarness{t: t, hub: hub, doc: doc}
}

func (h *roomHarness) join(name string, user uuid.UUID, role Role, queue int) (*Room, *Conn) {
	h.t.Helper()
	cfg := h.hub.cfg
	cfg.SendQueueSize = queue
	c := newConn(name, nil, &cfg, Principal{UserID: user, Role: role, DisplayName: name}, uuid.New())
	room, _, err := h.hub.join(h.doc, c)
	if err != nil {
		h.t.Fatal(err)
	}
	// The room publishes presence just after replying to the join. The
	// inbox is FIFO, so once this answers, that is done.
	room.memberCount()
	return room, c
}

// queuedPresence drains c's queue (standing in for its writer) and returns
// the presence lists found, in order.
func queuedPresence(c *Conn) [][]presenceUser {
	var out [][]presenceUser
	for {
		select {
		case frame := <-c.send:
			var m presenceMessage
			if json.Unmarshal(frame, &m) == nil && m.Type == "presence" {
				out = append(out, m.Users)
			}
		default:
			return out
		}
	}
}

// A presence broadcast that finds a full queue evicts that connection (the
// room never waits), and the eviction itself is published: the remaining
// members get a list without the slow connection's user.
func TestPresenceBroadcastEvictsSlowConnection(t *testing.T) {
	h := newRoomHarness(t)
	fastID, slowID, thirdID := uuid.New(), uuid.New(), uuid.New()
	room, fast := h.join("fast", fastID, RoleEditor, 64)
	_, slow := h.join("slow", slowID, RoleEditor, 1) // one frame fills it
	_, _ = h.join("third", thirdID, RoleEditor, 64)
	if n := room.memberCount(); n != 2 { // also: every join has been handled
		t.Fatalf("members %d, want 2 (slow evicted)", n)
	}

	select {
	case <-slow.closing:
	default:
		t.Fatal("slow connection was not closed")
	}
	if slow.closeCode != CloseResyncRequired {
		t.Fatalf("slow close code %d", slow.closeCode)
	}
	if got := len(slow.send); got > cap(slow.send) || cap(slow.send) != 1 {
		t.Fatalf("slow queue %d/%d", got, cap(slow.send))
	}
	var got [][]uuid.UUID
	for _, users := range queuedPresence(fast) {
		got = append(got, userIDs(users))
	}
	want := [][]uuid.UUID{
		sortedIDs(fastID),
		sortedIDs(fastID, slowID),
		sortedIDs(fastID, slowID, thirdID), // the broadcast that overflowed slow
		sortedIDs(fastID, thirdID),         // ...and the eviction it caused
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("fast saw\n%v\nwant\n%v", got, want)
	}
}

// Two connections of one user can briefly disagree on role (around a role
// change). The user is listed once, with the higher role, whatever order
// the room's map iterates in.
func TestPresenceListsEachUserOnceWithHighestRole(t *testing.T) {
	h := newRoomHarness(t)
	alice := uuid.New()
	room, first := h.join("Alice", alice, RoleViewer, 64)
	if got := queuedPresence(first); len(got) != 1 || got[0][0].Role != RoleViewer {
		t.Fatalf("first presence %+v", got)
	}
	_, editor := h.join("Alice", alice, RoleEditor, 64)
	// More viewer tabs: each join recomputes the list over a map whose
	// iteration order varies, so an order-dependent choice shows up here.
	const extra = 8
	for range extra {
		h.join("Alice", alice, RoleViewer, 64)
	}
	if n := room.memberCount(); n != 2+extra {
		t.Fatalf("members %d", n)
	}
	frames := append(queuedPresence(first), queuedPresence(editor)...)
	if len(frames) != 2 { // first: the change to editor; editor: its snapshot
		t.Fatalf("presence frames %+v, want one change and one snapshot", frames)
	}
	for _, users := range frames {
		if len(users) != 1 || users[0].Role != RoleEditor {
			t.Fatalf("presence %+v, want alice once as editor", users)
		}
	}
}

// --- concurrency ---

// Many users join, open second tabs, and leave concurrently while another
// user writes. Under -race this checks presence handling for data races;
// functionally it checks that
//   - an observer's update stream stays contiguous (presence frames do not
//     disturb sequencing),
//   - consecutive presence frames always differ (sent only on change),
//   - once the churn is over, presence is exactly the users still connected.
func TestPresenceUnderConcurrentChurn(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	observer := e.open(doc, uuid.New(), "Observer", RoleViewer, "")
	writer := e.open(doc, uuid.New(), "Writer", RoleEditor, "")
	observer.mustSync(t, 0)
	writer.mustSync(t, 0)

	const users, updates = 12, 60
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		stayers []uuid.UUID
		errs    = make(chan error, users+1)
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errs <- runWriter(writer.client, 0, updates, 4)
	}()
	for i := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := uuid.New()
			stay := i%3 == 0 // these keep one tab open to the end
			tabs := 1 + i%2
			var conns []*client
			for range tabs {
				c, _, err := e.dialAs(doc, id, uuid.New(), RoleEditor, http.Header{"X-Test-Name": {fmt.Sprint("U", i)}})
				if err != nil {
					errs <- err
					return
				}
				if _, _, err := c.sync(0); err != nil {
					errs <- fmt.Errorf("user %d: %w", i, err)
					return
				}
				conns = append(conns, c)
				time.Sleep(time.Duration(rand.IntN(5)) * time.Millisecond)
			}
			for k, c := range conns {
				if stay && k == len(conns)-1 {
					t.Cleanup(func() { c.ws.Close() })
					break
				}
				if rand.IntN(2) == 0 {
					c.ws.UnderlyingConn().Close() // abrupt
				} else {
					c.ws.Close()
				}
			}
			if stay {
				mu.Lock()
				stayers = append(stayers, id)
				mu.Unlock()
			}
			errs <- nil
		}()
	}

	// The observer reads concurrently, checking both streams as it goes.
	type result struct {
		frames int
		err    error
	}
	observed := make(chan result, 1)
	stop := make(chan struct{})
	var last []uuid.UUID
	go func() {
		next, frames := int64(1), 0
		for {
			m, err := observer.readFrame()
			if err != nil {
				select {
				case <-stop:
					observed <- result{frames, nil}
				default:
					observed <- result{frames, err}
				}
				return
			}
			switch m.Type {
			case "update":
				if m.Seq != next {
					observed <- result{frames, fmt.Errorf("observer: seq %d, want %d", m.Seq, next)}
					return
				}
				next++
			case "presence":
				ids := userIDs(m.Users)
				if slices.Equal(ids, last) {
					observed <- result{frames, fmt.Errorf("presence sent without a change: %v", ids)}
					return
				}
				mu.Lock()
				last = ids
				mu.Unlock()
				frames++
			}
		}
	}()

	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	want := sortedIDs(append(stayers, observer.user, writer.user)...)
	// Leaves are processed asynchronously; the room's last word must be want.
	eventually(t, "presence settles", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return slices.Equal(last, want)
	})
	// A stayer's closed extra tab may still be leaving; it never changed
	// presence, so count connections separately.
	room := e.room(doc)
	eventually(t, "one connection per remaining user", func() bool { return room.memberCount() == len(want) })
	close(stop)
	observer.ws.Close()
	res := <-observed
	if res.err != nil {
		t.Fatal(res.err)
	}
	t.Logf("observer received %d presence frames", res.frames)
}
