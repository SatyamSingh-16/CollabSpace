package collab

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgconn"

	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

// Week 5 review findings, reproduced before they were fixed. Each test
// failed against the Week 4 code (see teach/phases/week-5-review.md).

// R3: the store reports an ambiguous commit, but the transaction is still
// open and commits a moment later. The reset room must not start from the
// stale head: then nobody would ever be sent the update unless its author
// resent it, and here the author is gone.
func TestLateLandingAmbiguousCommitIsSeenByTheNewRoom(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	author, observer := e.connect(doc), e.connect(doc)
	author.mustSync(t, 0)
	observer.mustSync(t, 0)

	landed := make(chan error, 1)
	e.fault.once(func(req store.AppendRequest, _ func() (store.AppendResult, error)) (store.AppendResult, error) {
		ctx := context.Background()
		tx, err := testPool.Begin(ctx)
		if err != nil {
			return store.AppendResult{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE documents SET head_seq = head_seq + 1 WHERE id = $1`, req.DocumentID); err != nil {
			return store.AppendResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload)
			VALUES ($1, 1, $2, $3, $4, $5)`,
			req.DocumentID, req.UserID, req.ClientID, req.ClientMsgID, req.Payload); err != nil {
			return store.AppendResult{}, err
		}
		go func() { // the COMMIT reaches the server after the client gave up on it
			time.Sleep(500 * time.Millisecond)
			landed <- tx.Commit(ctx)
		}()
		return store.AppendResult{}, fmt.Errorf("%w: injected", store.ErrCommitAmbiguous)
	})
	if err := author.update(1, []byte("late")); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*client{author, observer} {
		if err := c.expectClose(CloseResyncRequired); err != nil {
			t.Fatal(err)
		}
	}
	author.ws.Close() // the author left: nobody will resend

	again := must[*client](t)(e.reconnect(observer, doc))
	defer again.ws.Close()
	head, replay := again.mustSync(t, 0)
	if err := <-landed; err != nil {
		t.Fatalf("late commit: %v", err)
	}
	if head != 1 || len(replay) != 1 || string(replay[0].Data) != "late" {
		t.Fatalf("new room synced the observer at head %d (replay %d), but the database has seq 1", head, len(replay))
	}
}

// blockingStore lets a test hold the first append inside the store and see
// when it got there.
func holdFirstAppend(e *env) (entered chan struct{}, release chan struct{}) {
	entered, release = make(chan struct{}), make(chan struct{})
	e.fault.once(func(_ store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		close(entered)
		<-release
		return real()
	})
	return entered, release
}

// R4: once SetMemberRole has returned (the API then answers 204), nothing
// the removed member had queued may be committed. An append already inside
// the store at that moment may still land; queued ones must not.
func TestRemovedMembersQueuedUpdatesAreNotCommitted(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	member := e.connect(doc)
	member.mustSync(t, 0)
	entered, release := holdFirstAppend(e)

	if err := member.update(1, []byte("in flight")); err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := member.update(2, []byte("queued")); err != nil {
		t.Fatal(err)
	}
	room := e.room(doc)
	// The reader hands update 2 to the room's inbox asynchronously; wait
	// until it is queued (inbox length is safe to read).
	eventually(t, "update 2 queued", func() bool { return len(room.inbox) == 1 })

	e.hub.SetMemberRole(doc, member.user, "")
	close(release)
	if err := member.expectClose(CloseForbidden); err != nil {
		t.Fatal(err)
	}
	room.memberCount() // every queued event has been handled
	if head, _ := e.store.HeadSeq(context.Background(), doc); head != 1 {
		t.Fatalf("head %d: a removed member's queued update was committed after the removal", head)
	}
}

// R10: SetMemberRole runs inside the owner's HTTP request. It must not wait
// for a busy room.
func TestSetMemberRoleDoesNotWaitForABusyRoom(t *testing.T) {
	cfg := testConfig()
	cfg.RoomInboxSize = 2
	e := newEnv(t, cfg)
	doc := e.newDoc()
	member := e.connect(doc)
	member.mustSync(t, 0)
	entered, release := holdFirstAppend(e)
	defer close(release)

	for i := int64(1); i <= 4; i++ { // 1 in the store, 2 queued, 1 waiting in submit
		if err := member.update(i, payload("u%d", i)); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			<-entered
		}
	}
	room := e.room(doc)
	eventually(t, "inbox full", func() bool { return len(room.inbox) == cap(room.inbox) })

	done := make(chan struct{})
	go func() {
		e.hub.SetMemberRole(doc, uuid.New(), RoleViewer) // someone else's change
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SetMemberRole blocked on a full room inbox")
	}
}

// R11: the hub remembers revocations for authzMemory. A handshake whose
// authorization was read longer ago than that must not be admitted on the
// strength of a memory that may have been pruned.
func TestStaleAuthorizationIsRefusedAfterRevocationsAreForgotten(t *testing.T) {
	hub := NewHub(store.New(testPool), testConfig(), slog.New(slog.DiscardHandler))
	hub.authzMemory = 200 * time.Millisecond
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	doc := uuid.New()
	if err := store.New(testPool).CreateDocument(context.Background(), doc, t.Name()); err != nil {
		t.Fatal(err)
	}
	user := testdb.NewUser(t, testPool)

	stalled, release := make(chan struct{}), make(chan struct{})
	router := chi.NewRouter()
	NewHandler(hub, func(*http.Request, uuid.UUID) (Principal, error) {
		close(stalled)
		<-release // the database is slow: authorization takes a long time
		return Principal{UserID: user, Role: RoleEditor, SessionID: "S1"}, nil
	}).Routes(router)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	type dialed struct {
		ws  *websocket.Conn
		err error
	}
	got := make(chan dialed, 1)
	go func() {
		ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/documents/"+doc.String(), nil)
		got <- dialed{ws, err}
	}()
	<-stalled
	hub.RevokeSession("S1")          // logout during the stall
	hub.SetMemberRole(doc, user, "") // and removal
	time.Sleep(3 * hub.authzMemory)
	hub.RevokeSession("someone-else") // any later revocation prunes old entries
	close(release)

	d := <-got
	if d.err != nil {
		return // refused before the upgrade: fine
	}
	c := &client{ws: d.ws, user: user, clientID: uuid.New()}
	defer c.ws.Close()
	if err := c.join(0); err != nil {
		t.Fatal(err)
	}
	m, err := c.read()
	if err == nil {
		t.Fatalf("revoked and removed member was admitted: %+v", m)
	}
	if !websocketCloseIs(err, CloseResyncRequired) && !websocketCloseIs(err, CloseUnauthenticated) {
		t.Fatalf("got %v, want a 4008 or 4001 close", err)
	}
}

func websocketCloseIs(err error, code int) bool {
	ce, ok := err.(*websocket.CloseError)
	return ok && ce.Code == code
}

// D6: an integrity violation can never succeed on retry, so the client must
// be told not to retry (it used to retry forever with "Saving…").
func TestPermanentStoreErrorIsNotRetryable(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	c := e.connect(doc)
	c.mustSync(t, 0)
	e.fault.once(func(store.AppendRequest, func() (store.AppendResult, error)) (store.AppendResult, error) {
		return store.AppendResult{}, fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23503"})
	})
	if err := c.update(1, []byte("x")); err != nil {
		t.Fatal(err)
	}
	m := must[serverMsg](t)(c.expect("error"))
	if m.Code != errCodePersistFailed || m.Retryable {
		t.Fatalf("error frame %+v, want persist_failed, not retryable", m)
	}
	// A transient failure is still retryable.
	e.fault.once(func(store.AppendRequest, func() (store.AppendResult, error)) (store.AppendResult, error) {
		return store.AppendResult{}, fmt.Errorf("insert: %w", &pgconn.PgError{Code: "57014"})
	})
	if err := c.update(2, []byte("y")); err != nil {
		t.Fatal(err)
	}
	if m := must[serverMsg](t)(c.expect("error")); !m.Retryable {
		t.Fatalf("transient error frame %+v, want retryable", m)
	}
}

// Week 5 Phase B: the counters operators see.
func TestStatsCountJoinsCommitsAndRevocations(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a := e.open(doc, uuid.New(), "A", RoleEditor, "sess-a")
	a.mustSync(t, 0)
	if err := a.update(1, []byte("x")); err != nil {
		t.Fatal(err)
	}
	must[serverMsg](t)(a.expect("committed"))
	s := e.hub.Stats()
	if s.Rooms != 1 || s.Connections != 1 || s.Joins != 1 || s.Commits != 1 {
		t.Fatalf("stats %+v", s)
	}
	e.hub.RevokeSession("sess-a")
	if err := a.expectClose(CloseUnauthenticated); err != nil {
		t.Fatal(err)
	}
	if s := e.hub.Stats(); s.Revoked != 1 {
		t.Fatalf("revocations %d", s.Revoked)
	}
}
