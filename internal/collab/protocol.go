// Package collab relays opaque Yjs updates between the browsers editing one
// document. It never interprets update bytes. It guarantees the ordering and
// durability rules from the Phase 0 design: every update is committed to the
// store before anyone is told about it, and every client receives committed
// updates in sequence order with no gaps.
package collab

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ProtocolVersion is the "v" field a client must send in its join message.
const ProtocolVersion = 1

// Application close codes (4000-4999 are reserved for applications by RFC 6455).
const (
	CloseNormal           = 1000
	CloseGoingAway        = 1001 // server shutdown
	CloseMessageTooBig    = 1009 // sent by Gorilla itself when the read limit is exceeded
	CloseInternalError    = 1011
	CloseUnauthenticated  = 4001
	CloseForbidden        = 4003
	CloseDocumentNotFound = 4004
	CloseResyncRequired   = 4008 // slow client or room reset: reconnect with after_seq
	CloseProtocolError    = 4009
	CloseRoomFull         = 4013
)

// Config holds the limits and timeouts for rooms and connections.
// The values in DefaultConfig are starting points, not measured limits.
type Config struct {
	SendQueueSize   int   // outbound frames buffered per connection
	RoomInboxSize   int   // events buffered per room
	MaxRoomConns    int   // connections per document
	MaxFrameBytes   int64 // WebSocket read limit
	MaxPayloadBytes int   // decoded Yjs update size; the database CHECK also enforces 512 KiB
	ReplayPageSize  int   // rows per ReadUpdates call during replay

	PingPeriod    time.Duration // how often the writer pings
	PongWait      time.Duration // read deadline, extended by every pong or message
	WriteWait     time.Duration // deadline for each frame write
	CloseGrace    time.Duration // deadline for writing the close frame
	JoinTimeout   time.Duration // time allowed for the join handshake
	SubmitTimeout time.Duration // how long a reader waits for a full room inbox
	StoreTimeout  time.Duration // deadline for each store call
	IdleTimeout   time.Duration // empty room lifetime before it is torn down

	// AllowedOrigins lists exact Origin header values accepted on upgrade.
	// Empty means Gorilla's default: the Origin host must equal the Host header.
	AllowedOrigins []string
}

func DefaultConfig() Config {
	return Config{
		SendQueueSize:   256,
		RoomInboxSize:   1024,
		MaxRoomConns:    50,
		MaxFrameBytes:   1 << 20,
		MaxPayloadBytes: 512 << 10,
		ReplayPageSize:  500,
		PingPeriod:      25 * time.Second,
		PongWait:        60 * time.Second,
		WriteWait:       10 * time.Second,
		CloseGrace:      time.Second,
		JoinTimeout:     10 * time.Second,
		SubmitTimeout:   time.Second,
		StoreTimeout:    5 * time.Second,
		IdleTimeout:     30 * time.Second,
	}
}

// Role is a user's permission level on a document.
type Role string

const (
	RoleOwner  Role = "owner"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

func (r Role) CanEdit() bool { return r == RoleOwner || r == RoleEditor }

// rank orders roles by permission, for picking one role per user when that
// user's connections disagree (briefly, around a role change).
func (r Role) rank() int {
	switch r {
	case RoleOwner:
		return 3
	case RoleEditor:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

// clientMessage is every frame a client may send. Data is a []byte, so
// encoding/json reads and writes it as standard base64.
type clientMessage struct {
	Type        string `json:"type"`
	V           int    `json:"v,omitempty"`
	ClientID    string `json:"client_id,omitempty"`
	AfterSeq    int64  `json:"after_seq,omitempty"`
	ClientMsgID int64  `json:"client_msg_id,omitempty"`
	Data        []byte `json:"data,omitempty"`
}

type joinedMessage struct {
	Type    string `json:"type"` // "joined"
	HeadSeq int64  `json:"head_seq"`
	Role    Role   `json:"role"`
	ConnID  string `json:"conn_id"`
}

type updateMessage struct {
	Type   string    `json:"type"` // "update"
	Seq    int64     `json:"seq"`
	Data   []byte    `json:"data"`
	UserID uuid.UUID `json:"user_id"`
}

type syncedMessage struct {
	Type string `json:"type"` // "synced"
	Seq  int64  `json:"seq"`
}

type committedMessage struct {
	Type        string `json:"type"` // "committed"
	ClientMsgID int64  `json:"client_msg_id"`
	Seq         int64  `json:"seq"`
}

// presenceMessage lists the unique users connected to the document, one
// entry per user however many tabs they have open. Identity, name and role
// come from the server's session and membership checks; the client sends
// nothing for presence. Email, session and connection IDs are left out on
// purpose: other members don't need them.
type presenceMessage struct {
	Type  string         `json:"type"` // "presence"
	Users []presenceUser `json:"users"`
}

type presenceUser struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
}

type errorMessage struct {
	Type        string `json:"type"` // "error"
	Code        string `json:"code"`
	Message     string `json:"message,omitempty"`
	ClientMsgID int64  `json:"client_msg_id,omitempty"`
	Retryable   bool   `json:"retryable"`
}

// Error codes carried in errorMessage.Code.
const (
	errCodePersistFailed  = "persist_failed"
	errCodeServerBusy     = "server_busy"
	errCodeInvalidPayload = "invalid_payload"
)

// encode marshals a server message into a frame. Frames are immutable once
// built, so one broadcast frame can be shared by every connection's queue.
func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Only fixed struct types are encoded here; failure is a programming error.
		panic("collab: encode: " + err.Error())
	}
	return b
}

func committedFrame(clientMsgID, seq int64) []byte {
	return encode(committedMessage{Type: "committed", ClientMsgID: clientMsgID, Seq: seq})
}

func updateFrame(seq int64, data []byte, userID uuid.UUID) []byte {
	return encode(updateMessage{Type: "update", Seq: seq, Data: data, UserID: userID})
}

func errorFrame(code, msg string, clientMsgID int64, retryable bool) []byte {
	return encode(errorMessage{Type: "error", Code: code, Message: msg, ClientMsgID: clientMsgID, Retryable: retryable})
}
