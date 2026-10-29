package collab

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

// --- joining and replay ---

func TestJoinEmptyDocument(t *testing.T) {
	e := newEnv(t, testConfig())
	c := e.connect(e.newDoc())

	head, replay := c.mustSync(t, 0)
	if head != 0 || len(replay) != 0 {
		t.Fatalf("head %d, replay %d; want empty", head, len(replay))
	}
}

func TestJoinReplaysPersistedHistory(t *testing.T) {
	cfg := testConfig()
	cfg.ReplayPageSize = 2 // 5 updates → pages of 2, 2, 1
	e := newEnv(t, cfg)
	doc := e.newDoc()
	author, client := testdb.NewUser(t, testPool), uuid.New()
	for i := int64(1); i <= 5; i++ {
		_, err := e.store.AppendUpdate(context.Background(), store.AppendRequest{
			DocumentID: doc, UserID: author, ClientID: client, ClientMsgID: i, Payload: payload("u%d", i),
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	head, replay := e.connect(doc).mustSync(t, 0)
	if head != 5 || len(replay) != 5 {
		t.Fatalf("head %d, replay %d; want 5, 5", head, len(replay))
	}
	for i, m := range replay {
		if want := payload("u%d", i+1); !bytes.Equal(m.Data, want) || m.UserID != author {
			t.Fatalf("replay[%d] = %q by %s, want %q by %s", i, m.Data, m.UserID, want, author)
		}
	}

	// A reconnecting client only gets what it is missing.
	head, replay = e.connect(doc).mustSync(t, 2)
	if head != 5 || len(replay) != 3 || replay[0].Seq != 3 {
		t.Fatalf("after_seq=2: head %d, replay %+v; want seqs 3..5", head, replay)
	}
}

// Another writer appends to the document behind the room's back (the room
// is meant to be the only writer). The room's next commit gets a seq that
// skips ahead; it must reset rather than broadcast a gap.
func TestExternalWriteResetsRoom(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a := e.connect(doc)
	a.mustSync(t, 0)

	if _, err := e.store.AppendUpdate(context.Background(), store.AppendRequest{
		DocumentID: doc, UserID: testdb.NewUser(t, testPool), ClientID: uuid.New(), ClientMsgID: 1, Payload: []byte("outside"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.update(1, []byte("inside")); err != nil {
		t.Fatal(err)
	}
	if err := a.expectClose(CloseResyncRequired); err != nil {
		t.Fatal(err)
	}
	// The update a sent was committed (seq 2); a fresh room replays both.
	a2 := must[*client](t)(e.reconnect(a, doc))
	defer a2.ws.Close()
	if head, replay := a2.mustSync(t, 0); head != 2 || string(replay[1].Data) != "inside" {
		t.Fatalf("after reset: head %d, replay %+v", head, replay)
	}
}

// A duplicate whose original seq is beyond the room's head means the room
// never broadcast that update (e.g. a COMMIT that landed after a reset, or an
// external writer). Acking only the sender would leave other live members
// permanently missing it, so the room must reset instead.
func TestDuplicateAheadOfHeadResetsRoom(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)

	// a's message 1 reaches the log without going through the room.
	if _, err := e.store.AppendUpdate(context.Background(), store.AppendRequest{
		DocumentID: doc, UserID: a.user, ClientID: a.clientID, ClientMsgID: 1, Payload: []byte("late"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.update(1, []byte("late")); err != nil {
		t.Fatal(err)
	}
	if err := b.expectClose(CloseResyncRequired); err != nil {
		t.Fatalf("observer: %v (it would never receive seq 1)", err)
	}
	b2 := must[*client](t)(e.reconnect(b, doc))
	defer b2.ws.Close()
	if head, replay := b2.mustSync(t, 0); head != 1 || string(replay[0].Data) != "late" {
		t.Fatalf("after reset: head %d, replay %+v", head, replay)
	}
}

func TestHeartbeats(t *testing.T) {
	cfg := testConfig()
	cfg.PingPeriod = 20 * time.Millisecond
	cfg.PongWait = 80 * time.Millisecond
	e := newEnv(t, cfg)
	doc := e.newDoc()

	// Gorilla's client answers pings automatically, but only while a read
	// is in progress. live keeps reading; silent never reads again.
	live, silent := e.connect(doc), e.connect(doc)
	live.mustSync(t, 0)
	silent.mustSync(t, 0)
	go func() {
		for {
			if _, _, err := live.ws.ReadMessage(); err != nil {
				return
			}
		}
	}()

	room := e.room(doc)
	// The silent client sends no pongs, so its read deadline expires.
	eventually(t, "silent client dropped", func() bool { return room.memberCount() == 1 })
	// Five more pong windows later, the live client is still there.
	deadline := time.Now().Add(5 * cfg.PongWait)
	for time.Now().Before(deadline) {
		if n := room.memberCount(); n != 1 {
			t.Fatalf("members %d, want the live client only", n)
		}
		time.Sleep(cfg.PingPeriod)
	}
}

// --- live updates ---

func TestTwoClientsExchangeUpdates(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)

	if err := a.update(1, []byte("from a")); err != nil {
		t.Fatal(err)
	}
	ack := must[serverMsg](t)(a.expect("committed"))
	got := must[serverMsg](t)(b.expect("update"))
	if ack.Seq != 1 || ack.ClientMsgID != 1 || got.Seq != 1 || string(got.Data) != "from a" || got.UserID != a.user {
		t.Fatalf("ack %+v, update %+v", ack, got)
	}

	if err := b.update(1, []byte("from b")); err != nil {
		t.Fatal(err)
	}
	ack = must[serverMsg](t)(b.expect("committed"))
	got = must[serverMsg](t)(a.expect("update"))
	if ack.Seq != 2 || got.Seq != 2 || string(got.Data) != "from b" {
		t.Fatalf("ack %+v, update %+v", ack, got)
	}
}

// Several writers submit at once. Every writer and a passive observer must
// see one contiguous sequence, and the log must hold exactly what was sent.
func TestConcurrentWritersGetContiguousSeqs(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	const writers, perWriter = 4, 40
	const total = writers * perWriter

	observer := e.connect(doc)
	observer.mustSync(t, 0)
	ws := make([]*client, writers)
	for i := range ws {
		ws[i] = e.connect(doc)
		ws[i].mustSync(t, 0)
	}

	var wg sync.WaitGroup
	errs := make(chan error, writers+1)
	for w, c := range ws {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- runWriter(c, w, perWriter, perWriter) // all in flight: maximum contention
		}()
	}
	observed := make(map[int64][]byte)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errs <- readContiguous(observer, 0, total, observed)
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	checkLogMatches(t, e, doc, total, observed)
}

// runWriter sends n updates, keeping at most window of them unacknowledged
// (like a client with a bounded pending set), and reads until all n are
// acknowledged, checking that every seq it sees (its own acks and others'
// updates) is contiguous. window == n means "send everything at once".
func runWriter(c *client, w, n, window int) error {
	sent, acked := 0, 0
	var last int64 = -1
	for acked < n {
		for sent < n && sent-acked < window {
			sent++
			if err := c.update(int64(sent), payload("w%d-%d", w, sent)); err != nil {
				return err
			}
		}
		m, err := c.read()
		if err != nil {
			return fmt.Errorf("writer %d: %w", w, err)
		}
		if m.Type != "update" && m.Type != "committed" {
			return fmt.Errorf("writer %d: unexpected %+v", w, m)
		}
		if last >= 0 && m.Seq != last+1 {
			return fmt.Errorf("writer %d: seq %d after %d", w, m.Seq, last)
		}
		last = m.Seq
		if m.Type == "committed" {
			acked++
		}
	}
	return nil
}

// readContiguous reads live updates until seq reaches upto, requiring each
// to be exactly the previous seq + 1. Payloads are recorded in seen.
func readContiguous(c *client, after, upto int64, seen map[int64][]byte) error {
	for after < upto {
		m, err := c.read()
		if err != nil {
			return fmt.Errorf("after seq %d: %w", after, err)
		}
		if m.Type != "update" || m.Seq != after+1 {
			return fmt.Errorf("after seq %d got %+v", after, m)
		}
		seen[m.Seq] = m.Data
		after = m.Seq
	}
	return nil
}

func checkLogMatches(t *testing.T, e *env, doc uuid.UUID, total int64, seen map[int64][]byte) {
	t.Helper()
	ctx := context.Background()
	if head, err := e.store.HeadSeq(ctx, doc); err != nil || head != total {
		t.Fatalf("head = %d, %v; want %d", head, err, total)
	}
	rows, err := e.store.ReadUpdates(ctx, doc, 0, total, int(total)+1)
	if err != nil || int64(len(rows)) != total {
		t.Fatalf("log has %d rows, %v; want %d", len(rows), err, total)
	}
	for _, r := range rows {
		if got, ok := seen[r.Seq]; ok && !bytes.Equal(got, r.Payload) {
			t.Fatalf("seq %d: client saw %q, log has %q", r.Seq, got, r.Payload)
		}
	}
}

// The core synchronisation test (PoC test 1): clients join at random moments
// while writers are submitting, and some disconnect mid-stream and rejoin
// with after_seq. Each must see every committed update exactly once, in
// order: replay up to the head it joined at, then live updates after it.
func TestJoinWhileOthersWrite(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	const writers, perWriter, joiners = 3, 50, 6
	const total = writers * perWriter

	// Slow each commit slightly so writing spans a window joiners can land
	// in, and signal when half the log is committed. Joiners 0-2 wait for
	// that signal, so they are guaranteed to join while writes are still
	// arriving; joiners 3-5 join after a random delay.
	midway := make(chan struct{})
	var midOnce sync.Once
	e.fault.setHook(func(_ store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		time.Sleep(500 * time.Microsecond)
		res, err := real()
		if err == nil && res.Seq >= total/2 {
			midOnce.Do(func() { close(midway) })
		}
		return res, err
	})

	ws := make([]*client, writers)
	for i := range ws {
		ws[i] = e.connect(doc)
		ws[i].mustSync(t, 0)
	}

	var (
		wg    sync.WaitGroup
		errs  = make(chan error, writers+joiners)
		mu    sync.Mutex
		views []map[int64][]byte
		heads = make([]int64, joiners) // head each joiner first synced at
	)
	for w, c := range ws {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- runWriter(c, w, perWriter, 2) // paced, so joins interleave with commits
		}()
	}
	for j := range joiners {
		seen := make(map[int64][]byte)
		mu.Lock()
		views = append(views, seen)
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if j < 3 {
				<-midway
			} else {
				time.Sleep(time.Duration(rand.IntN(100)) * time.Millisecond)
			}
			errs <- runJoiner(e, doc, j, total, seen, &heads[j])
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("joiners first synced at heads %v (of %d)", heads, total)
	midStream := 0
	for j, h := range heads {
		if j < 3 && h < total/2 {
			t.Fatalf("joiner %d synced at head %d, before the midway signal", j, h)
		}
		if h > 0 && h < total {
			midStream++
		}
	}
	// If every join landed before or after the writes, this test proved
	// nothing about replay/live ordering, so that counts as a failure.
	if midStream == 0 {
		t.Fatal("no joiner synced while writes were in progress")
	}
	for _, seen := range views {
		if int64(len(seen)) != total {
			t.Fatalf("a joiner saw %d updates, want %d", len(seen), total)
		}
		checkLogMatches(t, e, doc, total, seen)
	}
}

func runJoiner(e *env, doc uuid.UUID, j int, total int64, seen map[int64][]byte, firstHead *int64) error {
	c, _, err := e.dialAs(doc, uuid.New(), uuid.New(), RoleEditor, nil)
	if err != nil {
		return err
	}
	defer func() { c.ws.Close() }()

	head, replay, err := c.sync(0)
	if err != nil {
		return fmt.Errorf("joiner %d: %w", j, err)
	}
	*firstHead = head
	for _, m := range replay {
		seen[m.Seq] = m.Data
	}

	// Half the joiners drop their connection part-way and resume.
	if j%2 == 0 && head < total {
		stopAt := head + 1 + int64(rand.IntN(int(total-head)))
		if err := readContiguous(c, head, stopAt, seen); err != nil {
			return fmt.Errorf("joiner %d before reconnect: %w", j, err)
		}
		c.ws.Close()
		if c, err = e.reconnect(c, doc); err != nil {
			return err
		}
		h2, replay, err := c.sync(stopAt)
		if err != nil {
			return fmt.Errorf("joiner %d resync after %d: %w", j, stopAt, err)
		}
		for _, m := range replay {
			seen[m.Seq] = m.Data
		}
		head = h2
	}
	if err := readContiguous(c, head, total, seen); err != nil {
		return fmt.Errorf("joiner %d live: %w", j, err)
	}
	return nil
}

// --- idempotency ---

func TestDuplicateSubmissionIsAckedButNotRebroadcast(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)
	m := must[serverMsg](t)

	// Same connection resends message 1.
	if err := a.update(1, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if ack := m(a.expect("committed")); ack.Seq != 1 {
		t.Fatalf("ack %+v", ack)
	}
	m(b.expect("update"))
	if err := a.update(1, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if ack := m(a.expect("committed")); ack.Seq != 1 || ack.ClientMsgID != 1 {
		t.Fatalf("duplicate ack %+v, want seq 1", ack)
	}

	// After a reconnect, the same client ID retries message 2, which had
	// already been committed before the connection dropped.
	if err := a.update(2, []byte("y")); err != nil {
		t.Fatal(err)
	}
	m(a.expect("committed"))
	a.ws.Close()
	a2 := must[*client](t)(e.reconnect(a, doc))
	defer a2.ws.Close()
	a2.mustSync(t, 2)
	if err := a2.update(2, []byte("y")); err != nil {
		t.Fatal(err)
	}
	if ack := m(a2.expect("committed")); ack.Seq != 2 {
		t.Fatalf("retry ack %+v, want seq 2", ack)
	}

	// b must have seen 1 and 2 once each: its next message is seq 3.
	if got := m(b.expect("update")); got.Seq != 2 {
		t.Fatalf("b got %+v, want seq 2", got)
	}
	if err := a2.update(3, []byte("z")); err != nil {
		t.Fatal(err)
	}
	if got := m(b.expect("update")); got.Seq != 3 {
		t.Fatalf("b got %+v, want seq 3 (a duplicate was rebroadcast)", got)
	}
}

// --- backpressure ---

// Deterministic room-level test: the slow connection has no writer, so its
// queue is never drained. The room must evict it with 4008 and keep serving
// the fast connection, without ever blocking.
func TestSlowConnectionIsEvicted(t *testing.T) {
	cfg := testConfig()
	cfg.SendQueueSize = 2
	hub := NewHub(store.New(testPool), cfg, slog.New(slog.DiscardHandler))
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	doc := uuid.New()
	if err := store.New(testPool).CreateDocument(context.Background(), doc, t.Name()); err != nil {
		t.Fatal(err)
	}

	editor := Principal{UserID: testdb.NewUser(t, testPool), Role: RoleEditor}
	slow := newConn("slow", nil, &hub.cfg, editor, uuid.New())
	fastCfg := hub.cfg
	fastCfg.SendQueueSize = 64 // the fast side must not overflow by accident
	fast := newConn("fast", nil, &fastCfg, editor, uuid.New())
	room, _, err := hub.join(doc, slow)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := hub.join(doc, fast); err != nil {
		t.Fatal(err)
	}

	const n = 5
	acks := make(chan int64, n)
	go func() { // stands in for fast's writer goroutine
		for {
			select {
			case frame := <-fast.send:
				if bytes.Contains(frame, []byte(`"committed"`)) {
					acks <- 1
				}
			case <-fast.closing:
				return
			}
		}
	}()
	for i := int64(1); i <= n; i++ {
		if !room.submit(fast, i, payload("p%d", i)) {
			t.Fatal("submit refused")
		}
	}
	for range n {
		select {
		case <-acks:
		case <-time.After(5 * time.Second):
			t.Fatal("fast connection stopped receiving acks")
		}
	}
	select {
	case <-slow.closing:
	default:
		t.Fatal("slow connection was not closed")
	}
	if slow.closeCode != CloseResyncRequired {
		t.Fatalf("slow close code %d, want %d", slow.closeCode, CloseResyncRequired)
	}
	if got := room.memberCount(); got != 1 {
		t.Fatalf("room has %d members, want 1", got)
	}
}

// Week 3 review #3: a connection revoked (logout, expiry) after its join
// frame was read must not be registered, and once registered, a revoked
// connection's queued updates must not be committed.
func TestRevokedConnectionCannotJoinOrCommit(t *testing.T) {
	hub := NewHub(store.New(testPool), testConfig(), slog.New(slog.DiscardHandler))
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	doc := uuid.New()
	if err := store.New(testPool).CreateDocument(context.Background(), doc, t.Name()); err != nil {
		t.Fatal(err)
	}
	editor := Principal{UserID: testdb.NewUser(t, testPool), Role: RoleEditor}

	early := newConn("early", nil, &hub.cfg, editor, uuid.New())
	early.close(CloseUnauthenticated, "signed out")
	if _, _, err := hub.join(doc, early); !errors.Is(err, errSessionRevoked) {
		t.Fatalf("join of a revoked connection: %v", err)
	}

	late := newConn("late", nil, &hub.cfg, editor, uuid.New())
	room, _, err := hub.join(doc, late)
	if err != nil {
		t.Fatal(err)
	}
	late.close(CloseUnauthenticated, "signed out") // revoked while its update is queued
	// Queue the event directly: room.submit's select could also notice
	// "closing" and skip queuing, which would leave the commit-time check
	// untested about half the time (seen in a mutation check).
	room.inbox <- submitEvent{conn: late, clientMsgID: 1, payload: []byte("after revocation")}
	// The inbox is FIFO: once memberCount answers, the submit was handled.
	if n := room.memberCount(); n < 0 {
		t.Fatal("room died")
	}
	if head, _ := store.New(testPool).HeadSeq(context.Background(), doc); head != 0 {
		t.Fatalf("head = %d: a revoked connection's update was committed", head)
	}
}

// End-to-end: a client that stops reading must not stall the others. Large
// payloads fill the socket buffers so the slow client's queue overflows.
func TestSlowClientDoesNotBlockOthers(t *testing.T) {
	cfg := testConfig()
	cfg.SendQueueSize = 16
	e := newEnv(t, cfg)
	doc := e.newDoc()

	slow, writer, observer := e.connect(doc), e.connect(doc), e.connect(doc)
	slow.mustSync(t, 0) // ...and never reads again
	writer.mustSync(t, 0)
	observer.mustSync(t, 0)

	const n = 250
	big := bytes.Repeat([]byte("x"), 64<<10)
	errs := make(chan error, 2)
	go func() {
		for i := int64(1); i <= n; i++ {
			if err := writer.update(i, big); err != nil {
				errs <- err
				return
			}
		}
		for range n {
			if _, err := writer.expect("committed"); err != nil {
				errs <- err
				return
			}
		}
		errs <- nil
	}()
	go func() { errs <- readContiguous(observer, 0, n, map[int64][]byte{}) }()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if got := e.room(doc).memberCount(); got != 2 {
		t.Fatalf("room has %d members, want 2 (slow client evicted)", got)
	}
	// The slow client is disconnected; whatever it had buffered, it never
	// receives all n updates.
	if err := readContiguous(slow, 0, n, map[int64][]byte{}); err == nil {
		t.Fatal("slow client received every update; it should have been evicted")
	}
}

// --- disconnects and room lifecycle ---

func TestDisconnectRemovesConnectionAndIdleRoomStops(t *testing.T) {
	cfg := testConfig()
	cfg.IdleTimeout = 50 * time.Millisecond
	e := newEnv(t, cfg)
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)
	room := e.room(doc)
	if got := room.memberCount(); got != 2 {
		t.Fatalf("members %d, want 2", got)
	}

	// Abrupt disconnect: drop TCP without a close frame.
	a.ws.UnderlyingConn().Close()
	eventually(t, "a removed", func() bool { return room.memberCount() == 1 })

	b.ws.Close()
	eventually(t, "idle room removed", func() bool { return e.room(doc) == nil })
	<-room.done

	// A later join starts a fresh room that reloads head from the database.
	c := e.connect(doc)
	if head, _ := c.mustSync(t, 0); head != 0 {
		t.Fatalf("head %d", head)
	}
}

func TestRoomsAreIndependent(t *testing.T) {
	e := newEnv(t, testConfig())
	stuckDoc, freeDoc := e.newDoc(), e.newDoc()
	release := make(chan struct{})
	e.fault.setHook(func(req store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		if req.DocumentID == stuckDoc {
			<-release
		}
		return real()
	})

	a, b := e.connect(stuckDoc), e.connect(freeDoc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)
	if err := a.update(1, []byte("stuck")); err != nil {
		t.Fatal(err)
	}
	if err := b.update(1, []byte("free")); err != nil {
		t.Fatal(err)
	}
	if ack := must[serverMsg](t)(b.expect("committed")); ack.Seq != 1 {
		t.Fatalf("free doc ack %+v", ack)
	}
	close(release)
	if ack := must[serverMsg](t)(a.expect("committed")); ack.Seq != 1 {
		t.Fatalf("stuck doc ack %+v", ack)
	}
}

// --- store failures ---

func TestStoreFailureSendsNoAckAndNoBroadcast(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)
	m := must[serverMsg](t)

	e.fault.once(func(store.AppendRequest, func() (store.AppendResult, error)) (store.AppendResult, error) {
		return store.AppendResult{}, errors.New("injected: insert failed")
	})
	if err := a.update(1, []byte("first try")); err != nil {
		t.Fatal(err)
	}
	if got := m(a.expect("error")); got.Code != errCodePersistFailed || !got.Retryable || got.ClientMsgID != 1 {
		t.Fatalf("error %+v", got)
	}

	// Retry with the same ID succeeds. b's first message is this seq 1, so
	// the failed attempt was never broadcast and consumed no seq.
	if err := a.update(1, []byte("first try")); err != nil {
		t.Fatal(err)
	}
	if ack := m(a.expect("committed")); ack.Seq != 1 {
		t.Fatalf("ack %+v", ack)
	}
	if got := m(b.expect("update")); got.Seq != 1 {
		t.Fatalf("b got %+v", got)
	}
}

func TestAmbiguousCommitThatLandedRecovers(t *testing.T) {
	testAmbiguousCommit(t, true)
}

func TestAmbiguousCommitThatDidNotLandRecovers(t *testing.T) {
	testAmbiguousCommit(t, false)
}

// The store reports ErrCommitAmbiguous: the room must not ack or broadcast,
// must reset (4008 to everyone), and after clients reconnect and resend with
// the same IDs the log must contain the update exactly once.
func testAmbiguousCommit(t *testing.T, landed bool) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)
	m := must[serverMsg](t)

	e.fault.once(func(_ store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		if landed {
			if _, err := real(); err != nil {
				return store.AppendResult{}, err
			}
		}
		return store.AppendResult{}, fmt.Errorf("%w: injected connection reset", store.ErrCommitAmbiguous)
	})
	if err := a.update(1, []byte("maybe")); err != nil {
		t.Fatal(err)
	}
	// Neither client may see an ack or the update before the close.
	for _, c := range []*client{a, b} {
		m, err := c.read()
		var ce *websocket.CloseError
		if !errors.As(err, &ce) || ce.Code != CloseResyncRequired {
			t.Fatalf("got %+v, %v; want close %d", m, err, CloseResyncRequired)
		}
	}

	a2 := must[*client](t)(e.reconnect(a, doc))
	defer a2.ws.Close()
	head, replay := a2.mustSync(t, 0)
	wantHead := int64(0)
	if landed {
		wantHead = 1
	}
	if head != wantHead || int64(len(replay)) != wantHead {
		t.Fatalf("after reset: head %d, replay %d; want %d", head, len(replay), wantHead)
	}
	// The client resends its pending update with the same ID.
	if err := a2.update(1, []byte("maybe")); err != nil {
		t.Fatal(err)
	}
	if ack := m(a2.expect("committed")); ack.Seq != 1 {
		t.Fatalf("resend ack %+v, want seq 1", ack)
	}
	b2 := must[*client](t)(e.reconnect(b, doc))
	defer b2.ws.Close()
	if head, replay := b2.mustSync(t, 0); head != 1 || string(replay[0].Data) != "maybe" {
		t.Fatalf("b after reset: head %d, replay %+v", head, replay)
	}
	checkLogMatches(t, e, doc, 1, map[int64][]byte{1: []byte("maybe")})
}

// --- shutdown ---

func TestShutdownClosesConnections(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	a, b := e.connect(doc), e.connect(doc)
	a.mustSync(t, 0)
	b.mustSync(t, 0)

	shutdownErr := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownErr <- e.hub.Shutdown(ctx)
	}()
	for _, c := range []*client{a, b} {
		if err := c.expectClose(CloseGoingAway); err != nil {
			t.Fatal(err)
		}
	}
	if err := <-shutdownErr; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	// Every room and connection goroutine has exited (Shutdown waited for
	// them); the hub holds nothing and refuses new connections.
	e.hub.mu.Lock()
	rooms, conns := len(e.hub.rooms), len(e.hub.conns)
	e.hub.mu.Unlock()
	if rooms != 0 || conns != 0 {
		t.Fatalf("after shutdown: %d rooms, %d conns", rooms, conns)
	}
	_, resp, err := e.dialAs(doc, uuid.New(), uuid.New(), RoleEditor, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("dial after shutdown: %v, %v; want 503", err, resp)
	}
}

// A client that connected but never sent its join belongs to no room. Shutdown
// must still close it promptly rather than wait out JoinTimeout.
func TestShutdownClosesConnectionsStillInHandshake(t *testing.T) {
	e := newEnv(t, testConfig()) // JoinTimeout is 5 s
	c := e.connect(e.newDoc())   // no join sent
	eventually(t, "connection tracked", func() bool {
		e.hub.mu.Lock()
		defer e.hub.mu.Unlock()
		return len(e.hub.conns) == 1
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if err := e.hub.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("shutdown took %v, it waited for the handshake", d)
	}
	if _, err := c.read(); err == nil {
		t.Fatal("handshaking connection still open")
	}
}

// A room stuck in a store call cannot react to shutdown. When the deadline
// passes, Shutdown must close the sockets itself and report the timeout
// instead of hanging.
func TestShutdownDeadlineForcesSocketsClosed(t *testing.T) {
	e := newEnv(t, testConfig())
	doc := e.newDoc()
	release := make(chan struct{})
	e.fault.setHook(func(_ store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		<-release
		return real()
	})
	a := e.connect(doc)
	a.mustSync(t, 0)
	if err := a.update(1, []byte("stuck")); err != nil {
		t.Fatal(err)
	}
	// Wait until the room is inside the store call (it can't answer).
	eventually(t, "room busy", func() bool {
		r := e.room(doc)
		reply := make(chan int, 1)
		select {
		case r.inbox <- countEvent{reply: reply}:
		default:
			return false
		}
		select {
		case <-reply:
			return false // still responsive
		case <-time.After(50 * time.Millisecond):
			return true
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := e.hub.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown = %v, want deadline exceeded", err)
	}
	// The socket was closed under the client, without a close frame.
	if _, err := a.read(); err == nil {
		t.Fatal("connection still open after forced shutdown")
	}
	close(release) // let the room finish; env cleanup waits for it
}

// --- validation and permissions ---

func TestHandshakeRejections(t *testing.T) {
	cfg := testConfig()
	cfg.AllowedOrigins = []string{"https://app.example"}
	e := newEnv(t, cfg)
	doc := e.newDoc()

	cases := []struct {
		name   string
		header http.Header
		user   uuid.UUID
		want   int
	}{
		{"unauthenticated", nil, uuid.Nil, http.StatusUnauthorized},
		{"no access", http.Header{"X-Test-Deny": {"1"}}, uuid.New(), http.StatusNotFound},
		{"foreign origin", http.Header{"Origin": {"https://evil.example"}}, uuid.New(), http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			for k, v := range tc.header {
				h[k] = v
			}
			if tc.user != uuid.Nil {
				h.Set("X-Test-User", tc.user.String())
			}
			_, resp, err := websocket.DefaultDialer.Dial(e.wsURL(doc), h)
			if err == nil || resp == nil || resp.StatusCode != tc.want {
				t.Fatalf("got %v, %v; want HTTP %d", err, resp, tc.want)
			}
		})
	}

	c, _, err := e.dialAs(doc, uuid.New(), uuid.New(), RoleEditor, http.Header{"Origin": {"https://app.example"}})
	if err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	}
	c.ws.Close()
}

func TestProtocolViolationsCloseTheConnection(t *testing.T) {
	cfg := testConfig()
	cfg.MaxFrameBytes = 4 << 10
	cfg.MaxRoomConns = 2
	e := newEnv(t, cfg)
	// Sequential steps rather than t.Run: the env helpers report through the
	// parent test, which must not be failed from a subtest's goroutine.

	c := e.connect(e.newDoc())
	_ = c.update(1, []byte("x"))
	if err := c.expectClose(CloseProtocolError); err != nil {
		t.Fatalf("first message not a join: %v", err)
	}

	c = e.connect(e.newDoc())
	c.mustSync(t, 0)
	_ = c.ws.WriteMessage(websocket.TextMessage, []byte("{not json"))
	if err := c.expectClose(CloseProtocolError); err != nil {
		t.Fatalf("malformed json: %v", err)
	}

	c = e.connect(e.newDoc())
	c.mustSync(t, 0)
	_ = c.update(1, bytes.Repeat([]byte("x"), 8<<10))
	if err := c.expectClose(CloseMessageTooBig); err != nil {
		t.Fatalf("oversized frame: %v", err)
	}

	viewer, _, err := e.dialAs(e.newDoc(), uuid.New(), uuid.New(), RoleViewer, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.ws.Close()
	viewer.mustSync(t, 0)
	_ = viewer.update(1, []byte("x"))
	if err := viewer.expectClose(CloseForbidden); err != nil {
		t.Fatalf("viewer update: %v", err)
	}

	c = e.connect(e.newDoc())
	_ = c.join(5)
	if err := c.expectClose(CloseProtocolError); err != nil {
		t.Fatalf("after_seq ahead of head: %v", err)
	}

	// The test authorizer lets anyone in; the room's HeadSeq finds no row.
	c = e.connect(uuid.New())
	_ = c.join(0)
	if err := c.expectClose(CloseDocumentNotFound); err != nil {
		t.Fatalf("missing document: %v", err)
	}

	doc := e.newDoc()
	e.connect(doc).mustSync(t, 0)
	e.connect(doc).mustSync(t, 0)
	c = e.connect(doc)
	_ = c.join(0)
	if err := c.expectClose(CloseRoomFull); err != nil {
		t.Fatalf("room full: %v", err)
	}

	c = e.connect(e.newDoc())
	c.mustSync(t, 0)
	_ = c.update(1, nil)
	got := must[serverMsg](t)(c.expect("error"))
	if got.Code != errCodeInvalidPayload || got.Retryable {
		t.Fatalf("empty payload: error %+v", got)
	}
	_ = c.update(2, []byte("ok"))
	if ack := must[serverMsg](t)(c.expect("committed")); ack.Seq != 1 {
		t.Fatalf("session did not survive invalid payload: ack %+v", ack)
	}
}
