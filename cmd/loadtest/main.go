// Command loadtest drives a running CollabSpace deployment the way browsers
// do (HTTPS API, cookies, Origin, WebSockets through the proxy) and reports
// latency percentiles and errors. It is for local, bounded measurements of
// this single-instance setup, not a capacity claim. See docs/operations.md
// and teach/phases/week-6-deployment.md.
//
//	go run ./cmd/loadtest -base https://localhost:8443 -cacert deploy/secrets/tls/ca.pem \
//	    -docs 4 -members 3 -writers 1 -rate 5 -duration 10s
//
// Each run registers fresh users (docs × members), so the target's rate
// limits must allow that (the load-test override does; see
// deploy/compose.loadtest.yaml). Payloads are random bytes with a send
// timestamp; the server treats updates as opaque, so no Yjs is needed.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const maxConnections = 2000 // hard cap: this tool must not become a DoS tool

type config struct {
	base, origin, cacert          string
	docs, members, writers        int
	rate                          float64
	duration                      time.Duration
	payload                       int
	httpRequests, httpConcurrency int
	reconnectFraction             float64
	hold                          time.Duration
	setupConcurrency              int
}

func main() {
	var c config
	flag.StringVar(&c.base, "base", "https://localhost:8443", "deployment base URL")
	flag.StringVar(&c.origin, "origin", "", "Origin header (default: base)")
	flag.StringVar(&c.cacert, "cacert", "", "PEM file of the CA that signed the server certificate")
	flag.IntVar(&c.docs, "docs", 4, "documents")
	flag.IntVar(&c.members, "members", 3, "users (one connection each) per document")
	flag.IntVar(&c.writers, "writers", 1, "members per document that send updates")
	flag.Float64Var(&c.rate, "rate", 5, "updates per second per writer")
	flag.DurationVar(&c.duration, "duration", 10*time.Second, "length of the editing phase")
	flag.IntVar(&c.payload, "payload", 100, "update payload bytes")
	flag.IntVar(&c.httpRequests, "http-requests", 500, "API requests in the HTTP phase (0: skip)")
	flag.IntVar(&c.httpConcurrency, "http-concurrency", 20, "concurrent API requests")
	flag.Float64Var(&c.reconnectFraction, "reconnect", 0.2, "fraction of connections dropped and reconnected after editing (0: skip)")
	flag.DurationVar(&c.hold, "hold", 0, "instead of editing: keep connections open this long, reconnecting after any close (for restart tests)")
	flag.IntVar(&c.setupConcurrency, "setup-concurrency", 8, "concurrent registrations during setup")
	flag.Parse()
	if c.origin == "" {
		c.origin = c.base
	}
	if n := c.docs * c.members; n <= 0 || n > maxConnections || c.writers > c.members || c.payload < 16 || c.payload > 64<<10 {
		fmt.Fprintf(os.Stderr, "refusing: docs×members must be 1..%d, writers <= members, payload 16..65536\n", maxConnections)
		os.Exit(2)
	}
	if err := run(c); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// --- HTTP client with the deployment's CA ---

type client struct {
	cfg  config
	http *http.Client
	tls  *tls.Config
}

func newClient(c config) (*client, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.cacert != "" {
		pem, err := os.ReadFile(c.cacert)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("no certificate in -cacert")
		}
		tlsCfg.RootCAs = pool
	}
	tr := &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConnsPerHost: 256, ForceAttemptHTTP2: true}
	return &client{cfg: c, http: &http.Client{Transport: tr, Timeout: 30 * time.Second}, tls: tlsCfg}, nil
}

func (cl *client) do(method, path, cookie string, body any) (int, []byte, string, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, cl.cfg.base+path, r)
	if err != nil {
		return 0, nil, "", err
	}
	req.Header.Set("Origin", cl.cfg.origin)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	res, err := cl.http.Do(req)
	if err != nil {
		return 0, nil, "", err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	set := ""
	if h := res.Header.Get("Set-Cookie"); h != "" {
		set, _, _ = strings.Cut(h, ";")
	}
	return res.StatusCode, b, set, nil
}

// --- setup: users and documents ---

type user struct {
	email, cookie string // cookie is held in memory only and never printed
	id            string
	doc           string
	writer        bool
}

func setup(cl *client) ([]*user, error) {
	c := cl.cfg
	run := fmt.Sprintf("%d", time.Now().UnixNano())
	users := make([]*user, c.docs*c.members)
	sem := make(chan struct{}, c.setupConcurrency)
	var wg sync.WaitGroup
	var firstErr atomic.Value
	for i := range users {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			u := &user{email: fmt.Sprintf("load-%s-%d@example.test", run, i)}
			st, b, ck, err := cl.do("POST", "/api/auth/register", "", map[string]string{"email": u.email, "password": "load-test-password", "display_name": fmt.Sprintf("Load %d", i)})
			if err != nil || st != http.StatusCreated {
				firstErr.CompareAndSwap(nil, fmt.Errorf("register: %d %v %s", st, err, b))
				return
			}
			var r struct {
				User struct{ ID string } `json:"user"`
			}
			_ = json.Unmarshal(b, &r)
			u.id, u.cookie = r.User.ID, ck
			users[i] = u
		}()
	}
	wg.Wait()
	if err, _ := firstErr.Load().(error); err != nil {
		return nil, err
	}
	for d := range c.docs {
		group := users[d*c.members : (d+1)*c.members]
		owner := group[0]
		st, b, _, err := cl.do("POST", "/api/documents", owner.cookie, map[string]string{"title": fmt.Sprintf("load %s %d", run, d)})
		if err != nil || st != http.StatusCreated {
			return nil, fmt.Errorf("create document: %d %v %s", st, err, b)
		}
		var r struct {
			Document struct{ ID string } `json:"document"`
		}
		_ = json.Unmarshal(b, &r)
		for k, u := range group {
			u.doc = r.Document.ID
			u.writer = k < c.writers
			if k == 0 {
				continue
			}
			if st, b, _, err := cl.do("PUT", "/api/documents/"+u.doc+"/members", owner.cookie, map[string]string{"email": u.email, "role": "editor"}); err != nil || st != http.StatusOK {
				return nil, fmt.Errorf("share: %d %v %s", st, err, b)
			}
		}
	}
	return users, nil
}

// --- measurements ---

type samples struct {
	mu sync.Mutex
	d  []time.Duration
}

func (s *samples) add(d time.Duration) { s.mu.Lock(); s.d = append(s.d, d); s.mu.Unlock() }

func (s *samples) report(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.d) == 0 {
		fmt.Printf("%-28s n=0\n", name)
		return
	}
	slices.Sort(s.d)
	p := func(q float64) time.Duration { return s.d[min(len(s.d)-1, int(q*float64(len(s.d))))] }
	ms := func(d time.Duration) string { return fmt.Sprintf("%.1fms", float64(d.Microseconds())/1000) }
	fmt.Printf("%-28s n=%-7d p50=%-9s p95=%-9s p99=%-9s max=%s\n", name, len(s.d), ms(p(0.50)), ms(p(0.95)), ms(p(0.99)), ms(s.d[len(s.d)-1]))
}

type counters struct {
	mu sync.Mutex
	m  map[string]int
}

func (c *counters) inc(k string) { c.mu.Lock(); c.m[k]++; c.mu.Unlock() }

// --- HTTP phase ---

func httpPhase(cl *client, users []*user) {
	c := cl.cfg
	lat := &samples{}
	errs := &counters{m: map[string]int{}}
	jobs := make(chan int)
	var wg sync.WaitGroup
	start := time.Now()
	for range c.httpConcurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				u := users[i%len(users)]
				path := "/api/documents"
				if i%2 == 1 {
					path = "/api/documents/" + u.doc
				}
				t := time.Now()
				st, _, _, err := cl.do("GET", path, u.cookie, nil)
				lat.add(time.Since(t))
				switch {
				case err != nil:
					errs.inc("transport")
				case st != http.StatusOK:
					errs.inc(fmt.Sprintf("http_%d", st))
				}
			}
		}()
	}
	for i := range c.httpRequests {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	el := time.Since(start)
	fmt.Printf("\n== HTTP API: %d GET requests (documents list / one document), concurrency %d\n", c.httpRequests, c.httpConcurrency)
	lat.report("latency")
	fmt.Printf("throughput                   %.0f req/s, errors %v\n", float64(c.httpRequests)/el.Seconds(), errs.m)
}

// --- WebSocket connections ---

type conn struct {
	u       *user
	ws      *websocket.Conn
	wmu     sync.Mutex // one writer at a time (the editing goroutine, or close)
	applied atomic.Int64
	synced  chan struct{}
	closed  chan struct{}
	code    atomic.Int64
	pending sync.Map // client_msg_id -> send time
	nextID  atomic.Int64
	client  uuid.UUID
}

type wsRun struct {
	cl        *client
	connectLt samples
	commitLt  samples
	deliverLt samples
	resyncLt  samples
	delivered atomic.Int64
	committed atomic.Int64
	sent      atomic.Int64
	errs      counters
	closes    counters
	ending    atomic.Bool // the harness is closing its own connections; don't count those
}

func (r *wsRun) dial(u *user, clientID uuid.UUID, afterSeq int64) (*conn, error) {
	// Its own TLS config: the HTTP client's has "h2" in NextProtos (HTTP/2),
	// and a WebSocket upgrade needs an HTTP/1.1 connection.
	tlsCfg := r.cl.tls.Clone()
	tlsCfg.NextProtos = []string{"http/1.1"}
	d := websocket.Dialer{TLSClientConfig: tlsCfg, HandshakeTimeout: 15 * time.Second}
	h := http.Header{}
	h.Set("Cookie", u.cookie)
	h.Set("Origin", r.cl.cfg.origin)
	url := "wss" + strings.TrimPrefix(r.cl.cfg.base, "https") + "/ws/documents/" + u.doc
	ws, res, err := d.Dial(url, h)
	if err != nil {
		if res != nil {
			return nil, fmt.Errorf("dial: HTTP %d", res.StatusCode)
		}
		return nil, err
	}
	c := &conn{u: u, ws: ws, synced: make(chan struct{}), closed: make(chan struct{}), client: clientID}
	c.applied.Store(afterSeq)
	c.wmu.Lock()
	err = ws.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": clientID, "after_seq": afterSeq})
	c.wmu.Unlock()
	if err != nil {
		ws.Close()
		return nil, err
	}
	go r.read(c)
	return c, nil
}

func (r *wsRun) read(c *conn) {
	defer close(c.closed)
	syncedOnce := sync.Once{}
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			if r.ending.Load() {
				return
			}
			var ce *websocket.CloseError
			if errors.As(err, &ce) {
				c.code.Store(int64(ce.Code))
				r.closes.inc(fmt.Sprint(ce.Code))
			} else {
				c.code.Store(1006)
				r.closes.inc("1006/eof")
			}
			return
		}
		var m struct {
			Type        string `json:"type"`
			Seq         int64  `json:"seq"`
			ClientMsgID int64  `json:"client_msg_id"`
			Data        []byte `json:"data"`
			Code        string `json:"code"`
		}
		if json.Unmarshal(data, &m) != nil {
			r.errs.inc("bad_frame")
			continue
		}
		switch m.Type {
		case "synced":
			syncedOnce.Do(func() { close(c.synced) })
		case "update":
			if m.Seq > c.applied.Load() {
				c.applied.Store(m.Seq)
			}
			if len(m.Data) >= 8 && isSynced(c) {
				sent := int64(binary.BigEndian.Uint64(m.Data[:8]))
				r.deliverLt.add(time.Duration(time.Now().UnixNano() - sent))
				r.delivered.Add(1)
			}
		case "committed":
			if m.Seq > c.applied.Load() {
				c.applied.Store(m.Seq)
			}
			if t, ok := c.pending.LoadAndDelete(m.ClientMsgID); ok {
				r.commitLt.add(time.Since(t.(time.Time)))
				r.committed.Add(1)
			}
		case "error":
			r.errs.inc("server_error_" + m.Code)
		}
	}
}

func isSynced(c *conn) bool {
	select {
	case <-c.synced:
		return true
	default:
		return false
	}
}

func (r *wsRun) connectAll(users []*user) ([]*conn, error) {
	conns := make([]*conn, len(users))
	sem := make(chan struct{}, 32)
	var wg sync.WaitGroup
	var failed atomic.Int64
	for i, u := range users {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			t := time.Now()
			c, err := r.dial(u, uuid.New(), 0)
			if err != nil {
				failed.Add(1)
				r.errs.inc("connect: " + err.Error())
				return
			}
			select {
			case <-c.synced:
				r.connectLt.add(time.Since(t))
				conns[i] = c
			case <-c.closed:
				failed.Add(1)
				r.errs.inc("closed_before_sync")
			case <-time.After(20 * time.Second):
				failed.Add(1)
				r.errs.inc("sync_timeout")
			}
		}()
	}
	wg.Wait()
	if n := failed.Load(); n > 0 {
		return conns, fmt.Errorf("%d of %d connections failed", n, len(users))
	}
	return conns, nil
}

func (r *wsRun) send(c *conn, size int) error {
	id := c.nextID.Add(1)
	payload := make([]byte, size)
	_, _ = rand.Read(payload[8:])
	binary.BigEndian.PutUint64(payload, uint64(time.Now().UnixNano()))
	c.pending.Store(id, time.Now())
	c.wmu.Lock()
	err := c.ws.WriteJSON(map[string]any{"type": "update", "client_msg_id": id, "data": payload})
	c.wmu.Unlock()
	if err == nil {
		r.sent.Add(1)
	}
	return err
}

func (r *wsRun) edit(conns []*conn) {
	c := r.cl.cfg
	interval := time.Duration(float64(time.Second) / c.rate)
	ctx, cancel := context.WithTimeout(context.Background(), c.duration)
	defer cancel()
	var wg sync.WaitGroup
	for _, cn := range conns {
		if !cn.u.writer {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Spread writers out so they don't all send on the same tick.
			jitter := make([]byte, 2)
			_, _ = rand.Read(jitter)
			time.Sleep(time.Duration(binary.BigEndian.Uint16(jitter)) % interval)
			t := time.NewTicker(interval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-cn.closed:
					return
				case <-t.C:
					if err := r.send(cn, c.payload); err != nil {
						r.errs.inc("send")
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	time.Sleep(2 * time.Second) // let in-flight acks and deliveries arrive
}

func (r *wsRun) reconnect(conns []*conn) {
	n := int(float64(len(conns)) * r.cl.cfg.reconnectFraction)
	if n == 0 {
		return
	}
	var wg sync.WaitGroup
	var ok atomic.Int64
	reconnectErrs := &counters{m: map[string]int{}}
	for _, c := range conns[:n] {
		wg.Add(1)
		go func() {
			defer wg.Done()
			after := c.applied.Load()
			_ = c.ws.UnderlyingConn().Close() // abrupt: no close frame, like a lost network
			<-c.closed
			t := time.Now()
			nc, err := r.dial(c.u, c.client, after) // same tab: same client_id, resume from applied seq
			if err != nil {
				reconnectErrs.inc("dial: " + err.Error())
				return
			}
			select {
			case <-nc.synced:
				r.resyncLt.add(time.Since(t))
				ok.Add(1)
			case <-nc.closed:
				reconnectErrs.inc(fmt.Sprintf("closed before sync: %d", nc.code.Load()))
			case <-time.After(20 * time.Second):
				reconnectErrs.inc("resync_timeout")
			}
			_ = nc.ws.Close()
		}()
	}
	wg.Wait()
	fmt.Printf("\n== Reconnect: %d connections dropped (TCP close, no close frame) and resumed from their last seq\n", n)
	r.resyncLt.report("dial → synced")
	fmt.Printf("resumed                      %d/%d, failures %v\n", ok.Load(), n, reconnectErrs.m)
}

// hold keeps every connection open; after any close it redials (same
// client_id, from the last seq) with a short backoff and records how long
// recovery took and with which close code. For restart tests.
func (r *wsRun) hold(conns []*conn) {
	deadline := time.Now().Add(r.cl.cfg.hold)
	var wg sync.WaitGroup
	recovered := &samples{}
	var gaveUp atomic.Int64
	for _, c := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cur := c
			for {
				select {
				case <-cur.closed:
				case <-time.After(time.Until(deadline)):
					r.ending.Store(true)
					_ = cur.ws.Close()
					return
				}
				closedAt := time.Now()
				backoff := 500 * time.Millisecond
				for {
					if time.Now().After(deadline.Add(30 * time.Second)) {
						gaveUp.Add(1)
						return
					}
					nc, err := r.dial(c.u, c.client, cur.applied.Load())
					if err == nil {
						select {
						case <-nc.synced:
							recovered.add(time.Since(closedAt))
							cur = nc
						case <-nc.closed:
							err = errors.New("closed before sync")
						case <-time.After(10 * time.Second):
							err = errors.New("sync timeout")
						}
					}
					if err == nil {
						break
					}
					// Full jitter, like the browser provider: a restart must not
					// make every client reconnect in the same instant.
					var j [2]byte
					_, _ = rand.Read(j[:])
					time.Sleep(time.Duration(binary.BigEndian.Uint16(j[:])) * backoff / 65536)
					backoff = min(2*backoff, 2*time.Second)
				}
			}
		}()
	}
	wg.Wait()
	fmt.Printf("\n== Hold for %s with automatic reconnect\n", r.cl.cfg.hold)
	r.closes.mu.Lock()
	fmt.Printf("close codes seen             %v\n", r.closes.m)
	r.closes.mu.Unlock()
	recovered.report("close → resynced")
	fmt.Printf("never recovered              %d\n", gaveUp.Load())
}

func runWS(cl *client, users []*user) error {
	c := cl.cfg
	r := &wsRun{cl: cl, errs: counters{m: map[string]int{}}, closes: counters{m: map[string]int{}}}
	conns, err := r.connectAll(users)
	fmt.Printf("\n== WebSockets: %d connections (%d documents × %d members)\n", len(users), c.docs, c.members)
	r.connectLt.report("dial → synced")
	if err != nil {
		fmt.Printf("errors                       %v\n", r.errs.m)
		return err
	}
	if c.hold > 0 {
		r.hold(conns)
		return nil
	}
	fmt.Printf("phase editing start=%d\n", time.Now().Unix())
	r.edit(conns)
	fmt.Printf("phase editing end=%d\n", time.Now().Unix())
	sent, committed, delivered := r.sent.Load(), r.committed.Load(), r.delivered.Load()
	expected := committed * int64(c.members-1) // every other member of the document
	fmt.Printf("\n== Editing: %d writers/document × %.0f updates/s × %s, %d-byte payloads\n", c.writers, c.rate, c.duration, c.payload)
	r.commitLt.report("commit (send → committed)")
	r.deliverLt.report("delivery (send → others)")
	fmt.Printf("updates                      sent %d, committed %d, %.0f commits/s\n", sent, committed, float64(committed)/c.duration.Seconds())
	fmt.Printf("deliveries                   %d of %d expected\n", delivered, expected)
	r.errs.mu.Lock()
	fmt.Printf("errors                       %v\n", r.errs.m)
	r.errs.mu.Unlock()
	r.closes.mu.Lock()
	fmt.Printf("unexpected closes            %v\n", r.closes.m)
	r.closes.mu.Unlock()
	if c.reconnectFraction > 0 {
		r.reconnect(conns)
	}
	for _, cn := range conns {
		_ = cn.ws.Close()
	}
	return nil
}

func run(c config) error {
	cl, err := newClient(c)
	if err != nil {
		return err
	}
	fmt.Printf("target %s, %d documents × %d members = %d users\n", c.base, c.docs, c.members, c.docs*c.members)
	t := time.Now()
	users, err := setup(cl)
	if err != nil {
		return err
	}
	fmt.Printf("setup: %d users registered and documents shared in %s\n", len(users), time.Since(t).Round(time.Millisecond))
	if c.httpRequests > 0 {
		httpPhase(cl, users)
	}
	return runWS(cl, users)
}
