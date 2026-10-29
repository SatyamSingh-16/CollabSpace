package collab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Conn is one browser's WebSocket connection to one document.
//
// Goroutines: exactly one reader (readLoop, run by the HTTP handler) and one
// writer (writeLoop). Only the writer writes data frames, which is Gorilla's
// one-concurrent-writer rule. Other goroutines talk to the connection only
// through enqueue and close, which never block.
type Conn struct {
	id          string
	ws          *websocket.Conn
	cfg         *Config
	userID      uuid.UUID
	displayName string
	role        Role // from the handshake; a later change closes the connection (authz.go)
	clientID    uuid.UUID

	sessionID    string    // for Hub.RevokeSession
	docID        uuid.UUID // for Hub.SetMemberRole; set before trackConn
	authorizedAt time.Time // when the handshake's authorization was read

	// send is the bounded outbound queue. It is never closed, because it has
	// several senders (the room and the reader); shutdown is signalled through
	// closing instead.
	send chan []byte

	// handshaking is true until the join frame has been read. Shutdown closes
	// such sockets at once instead of waiting up to JoinTimeout for them.
	handshaking atomic.Bool

	closeOnce   sync.Once
	closing     chan struct{}
	closeCode   int    // written once, before closing is closed
	closeReason string // ditto
}

func newConn(id string, ws *websocket.Conn, cfg *Config, p Principal, clientID uuid.UUID) *Conn {
	return &Conn{
		id:          id,
		ws:          ws,
		cfg:         cfg,
		userID:      p.UserID,
		displayName: p.DisplayName,
		role:        p.Role,
		clientID:    clientID,
		sessionID:   p.SessionID,
		// serveConn overwrites this with the instant before the handshake's
		// authorization was read.
		authorizedAt: time.Now(),
		send:         make(chan []byte, cfg.SendQueueSize),
		closing:      make(chan struct{}),
	}
}

// enqueue offers a frame to the outbound queue without blocking. It returns
// false when the queue is full; the caller decides the policy (the room
// evicts the connection).
func (c *Conn) enqueue(frame []byte) bool {
	select {
	case c.send <- frame:
		return true
	default:
		return false
	}
}

// close asks the connection to shut down with the given close code. It is
// safe to call from any goroutine, any number of times; only the first call
// counts. It does not touch the socket: the writer sends the close frame and
// closes the socket, which in turn unblocks the reader.
func (c *Conn) close(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode, c.closeReason = code, reason
		close(c.closing)
	})
}

func (c *Conn) isClosing() bool {
	select {
	case <-c.closing:
		return true
	default:
		return false
	}
}

// closeNow is used before the writer goroutine exists (during the join
// handshake), so there is no concurrent data writer to race with.
func (c *Conn) closeNow(code int, reason string) {
	c.close(code, reason)
	c.teardown()
}

// teardown writes the close frame (best effort, bounded by CloseGrace) and
// closes the socket. Closing the socket is what releases a reader blocked in
// ReadMessage; cancelling a context would not.
func (c *Conn) teardown() {
	<-c.closing
	msg := websocket.FormatCloseMessage(c.closeCode, c.closeReason)
	_ = c.ws.WriteControl(websocket.CloseMessage, msg, time.Now().Add(c.cfg.CloseGrace))
	_ = c.ws.Close()
}

func (c *Conn) write(frame []byte) error {
	if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.WriteWait)); err != nil {
		return err
	}
	return c.ws.WriteMessage(websocket.TextMessage, frame)
}

func (c *Conn) ping() error {
	if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.WriteWait)); err != nil {
		return err
	}
	return c.ws.WriteMessage(websocket.PingMessage, nil)
}

// writeLoop is the only goroutine that writes data frames. It sends, in
// order: joined, the replay of (afterSeq, head], synced, then live frames
// from the queue. The room registered this connection at head, so every
// seq > head arrives through the queue (design §1, I2), and replay covers
// the rest (I1, I3).
func (c *Conn) writeLoop(st Store, docID uuid.UUID, afterSeq, head int64) {
	ticker := time.NewTicker(c.cfg.PingPeriod)
	defer func() {
		ticker.Stop()
		c.close(CloseInternalError, "writer stopped") // no-op if already closing
		c.teardown()
	}()

	if c.isClosing() {
		return // revoked between join and now: send nothing
	}
	joined := encode(joinedMessage{Type: "joined", HeadSeq: head, Role: c.role, ConnID: c.id})
	if err := c.write(joined); err != nil {
		return
	}
	if err := c.replay(st, docID, afterSeq, head, ticker.C); err != nil {
		c.close(CloseResyncRequired, "replay failed")
		return
	}
	if err := c.write(encode(syncedMessage{Type: "synced", Seq: head})); err != nil {
		return
	}

	for {
		select {
		case frame := <-c.send:
			// select picks at random when both are ready; a revoked or
			// evicted connection must not keep draining its queue.
			if c.isClosing() {
				return
			}
			if err := c.write(frame); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.ping(); err != nil {
				return
			}
		case <-c.closing:
			return
		}
	}
}

var errClosing = errors.New("connection closing")

// replay streams committed updates (afterSeq, head] from the store, one page
// at a time, checking that the sequence is contiguous.
func (c *Conn) replay(st Store, docID uuid.UUID, afterSeq, head int64, tick <-chan time.Time) error {
	for afterSeq < head {
		ctx, cancel := context.WithTimeout(context.Background(), c.cfg.StoreTimeout)
		page, err := st.ReadUpdates(ctx, docID, afterSeq, head, c.cfg.ReplayPageSize)
		cancel()
		if err != nil {
			return err
		}
		if len(page) == 0 {
			return fmt.Errorf("log ends at seq %d, before head %d", afterSeq, head)
		}
		for _, u := range page {
			if u.Seq != afterSeq+1 {
				return fmt.Errorf("gap in log: got seq %d after %d", u.Seq, afterSeq)
			}
			if err := c.write(updateFrame(u.Seq, u.Payload, u.UserID)); err != nil {
				return err
			}
			afterSeq = u.Seq
		}
		// A long replay must still ping, or the reader's deadline (extended
		// only by pongs and client messages) could expire.
		select {
		case <-tick:
			if err := c.ping(); err != nil {
				return err
			}
		case <-c.closing:
			return errClosing
		default:
		}
	}
	return nil
}

// readLoop runs in the HTTP handler's goroutine until the socket fails or
// the connection closes. It validates client frames and submits updates to
// the room.
func (c *Conn) readLoop(room *Room) {
	c.ws.SetReadLimit(c.cfg.MaxFrameBytes)
	extend := func() error { return c.ws.SetReadDeadline(time.Now().Add(c.cfg.PongWait)) }
	_ = extend()
	c.ws.SetPongHandler(func(string) error { return extend() })

	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			if errors.Is(err, websocket.ErrReadLimit) {
				// Gorilla has already sent a 1009 close frame to the peer.
				c.close(CloseMessageTooBig, "message too big")
			} else {
				c.close(CloseNormal, "")
			}
			return
		}
		_ = extend()

		var m clientMessage
		if err := json.Unmarshal(data, &m); err != nil {
			c.close(CloseProtocolError, "malformed message")
			return
		}
		switch m.Type {
		case "update":
			if !c.role.CanEdit() {
				c.close(CloseForbidden, "read-only access")
				return
			}
			if m.ClientMsgID <= 0 {
				c.close(CloseProtocolError, "client_msg_id must be positive")
				return
			}
			if len(m.Data) == 0 || len(m.Data) > c.cfg.MaxPayloadBytes {
				// A bad payload is the client's bug, but not a reason to drop
				// the session; it must not retry this message.
				if !c.enqueue(errorFrame(errCodeInvalidPayload, "payload empty or too large", m.ClientMsgID, false)) {
					// Dropping the error silently would leave the client
					// waiting forever on this message; make it resync.
					c.close(CloseResyncRequired, "send queue full")
					return
				}
				continue
			}
			if !room.submit(c, m.ClientMsgID, m.Data) {
				return
			}
		default:
			c.close(CloseProtocolError, "unexpected message type")
			return
		}
	}
}
