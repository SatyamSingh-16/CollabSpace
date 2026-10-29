package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"collabspace/internal/collab"
)

func TestRenameDocument(t *testing.T) {
	s := newServer(t, nil)
	owner, editor, viewer, stranger := s.register(t), s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "Draft")
	s.share(t, owner, doc, editor.email, "editor")
	s.share(t, owner, doc, viewer.email, "viewer")
	path := "/api/documents/" + doc

	if r := s.do("PATCH", path, map[string]any{"title": "  Launch plan  "}, owner.cookie); r.status != 200 ||
		r.field("document", "title") != "Launch plan" || r.field("document", "role") != "owner" {
		t.Fatalf("owner rename: %d %s", r.status, r.raw)
	}
	if r := s.do("PATCH", path, map[string]any{"title": "Launch plan v2"}, editor.cookie); r.status != 200 ||
		r.field("document", "role") != "editor" {
		t.Fatalf("editor rename: %d %s", r.status, r.raw)
	}
	if r := s.do("PATCH", path, map[string]any{"title": "Viewer's title"}, viewer.cookie); r.status != 403 {
		t.Fatalf("viewer rename: %d %s", r.status, r.raw)
	}
	if r := s.do("PATCH", path, map[string]any{"title": "Stranger's title"}, stranger.cookie); r.status != 404 {
		t.Fatalf("non-member rename: %d %s", r.status, r.raw)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 201)} {
		if r := s.do("PATCH", path, map[string]any{"title": bad}, owner.cookie); r.status != 400 {
			t.Errorf("title %q: %d", bad, r.status)
		}
	}
	// Every member sees the last accepted title.
	for _, a := range []account{owner, editor, viewer} {
		if r := s.do("GET", path, nil, a.cookie); r.field("document", "title") != "Launch plan v2" {
			t.Fatalf("title seen by %s: %s", a.email, r.raw)
		}
	}
}

func TestOnlyTheOwnerCanDeleteADocument(t *testing.T) {
	s := newServer(t, nil)
	owner, editor, viewer, stranger := s.register(t), s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "To delete")
	s.share(t, owner, doc, editor.email, "editor")
	s.share(t, owner, doc, viewer.email, "viewer")
	path := "/api/documents/" + doc

	editorWS, _ := s.joinWS(t, doc, editor)
	_ = editorWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{1}})
	if m, err := wsRead(t, editorWS); err != nil || m.Type != "committed" {
		t.Fatalf("editor's update: %+v %v", m, err)
	}
	ownerWS, _ := s.joinWS(t, doc, owner)

	for _, a := range []account{editor, viewer} {
		if r := s.do("DELETE", path, nil, a.cookie); r.status != 403 {
			t.Fatalf("%s deleting: %d %s", a.email, r.status, r.raw)
		}
	}
	if r := s.do("DELETE", path, nil, stranger.cookie); r.status != 404 {
		t.Fatalf("non-member deleting: %d", r.status)
	}
	if r := s.do("GET", path, nil, editor.cookie); r.status != 200 {
		t.Fatalf("refused deletes changed something: %d", r.status)
	}

	if r := s.do("DELETE", path, nil, owner.cookie); r.status != 204 {
		t.Fatalf("owner deleting: %d %s", r.status, r.raw)
	}
	// Everyone's open editor is closed, and nobody can reach it again.
	expectClose(t, editorWS, collab.CloseDocumentNotFound)
	expectClose(t, ownerWS, collab.CloseDocumentNotFound)
	for _, a := range []account{owner, editor, viewer} {
		if r := s.do("GET", path, nil, a.cookie); r.status != 404 {
			t.Fatalf("GET after delete by %s: %d", a.email, r.status)
		}
		if r := s.do("GET", "/api/documents", nil, a.cookie); len(r.field("documents").([]any)) != 0 {
			t.Fatalf("list after delete: %s", r.raw)
		}
		if _, resp, err := s.dialWS(doc, a.cookie, origin); err == nil || resp.StatusCode != 404 {
			t.Fatalf("reconnecting after delete: %v %v", err, resp)
		}
	}
	// Its history and sharing went with it.
	var updates, members int
	ctx := context.Background()
	_ = testPool.QueryRow(ctx, `SELECT count(*) FROM document_updates WHERE document_id = $1`, doc).Scan(&updates)
	_ = testPool.QueryRow(ctx, `SELECT count(*) FROM document_members WHERE document_id = $1`, doc).Scan(&members)
	if updates != 0 || members != 0 {
		t.Fatalf("left behind: %d updates, %d memberships", updates, members)
	}
	if r := s.do("DELETE", path, nil, owner.cookie); r.status != 404 {
		t.Fatalf("deleting twice: %d", r.status)
	}
}

func TestDocumentListShowsWhoIsOnline(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "Busy")
	quiet := s.createDoc(t, owner, "Quiet")
	s.share(t, owner, doc, bob.email, "editor")

	online := func(a account) map[string]float64 {
		r := s.do("GET", "/api/documents", nil, a.cookie)
		out := map[string]float64{}
		for _, d := range r.field("documents").([]any) {
			m := d.(map[string]any)
			out[m["id"].(string)] = m["online"].(float64)
		}
		return out
	}
	waitOnline := func(want float64) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for online(owner)[doc] != want {
			if time.Now().After(deadline) {
				t.Fatalf("online = %v, want %v", online(owner)[doc], want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	if got := online(owner); got[doc] != 0 || got[quiet] != 0 {
		t.Fatalf("nobody connected: %v", got)
	}
	s.joinWS(t, doc, owner)
	s.joinWS(t, doc, owner) // a second tab is still one person
	bobWS, _ := s.joinWS(t, doc, bob)
	if got := online(owner); got[doc] != 2 || got[quiet] != 0 {
		t.Fatalf("owner (2 tabs) + bob: %v", got)
	}
	if got := online(bob)[doc]; got != 2 {
		t.Fatalf("bob's view: %v", got)
	}
	bobWS.Close()
	waitOnline(1)
}
