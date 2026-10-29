package documents

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"collabspace/internal/auth"
	"collabspace/internal/httpx"
	"collabspace/internal/ratelimit"
)

type Handler struct {
	store *Store
	log   *slog.Logger
	live  Live
	// shareLimit is per signed-in user. Sharing answers 404 for an unknown
	// email, so without a limit one account could test emails for
	// registration as fast as the server answers (Week 5 review R7).
	shareLimit *ratelimit.Limiter
}

// Live connects the API to open collaboration connections. Any field may be
// nil. The hooks are called after the change is committed.
type Live struct {
	// MemberChanged: a membership changed (role "" = removed), so open
	// connections can be adjusted.
	MemberChanged func(docID, userID uuid.UUID, role Role)
	// Deleted: the document is gone; close its open connections.
	Deleted func(docID uuid.UUID)
	// Online counts the distinct users connected to each document.
	Online func(docIDs []uuid.UUID) map[uuid.UUID]int
}

// NewHandler builds the documents API. shareLimit may be nil (unlimited).
func NewHandler(store *Store, live Live, shareLimit *ratelimit.Limiter, log *slog.Logger) *Handler {
	if live.MemberChanged == nil {
		live.MemberChanged = func(uuid.UUID, uuid.UUID, Role) {}
	}
	if live.Deleted == nil {
		live.Deleted = func(uuid.UUID) {}
	}
	if live.Online == nil {
		live.Online = func([]uuid.UUID) map[uuid.UUID]int { return nil }
	}
	return &Handler{store: store, log: log, live: live, shareLimit: shareLimit}
}

// Routes mounts /documents/* on r. Every route requires a signed-in user
// (auth.RequireUser must wrap r) and checks membership itself.
func (h *Handler) Routes(r chi.Router) {
	r.Post("/documents", h.create)
	r.Get("/documents", h.list)
	r.Get("/documents/{docID}", h.get)
	r.Patch("/documents/{docID}", h.rename)
	r.Delete("/documents/{docID}", h.delete)
	r.Put("/documents/{docID}/members", h.setMember)
	r.Get("/documents/{docID}/members", h.listMembers)
	r.Delete("/documents/{docID}/members/{userID}", h.removeMember)
}

// requireOwner answers 404 for non-members and 403 for non-owners. It
// reports whether the caller is the owner.
func (h *Handler) requireOwner(w http.ResponseWriter, r *http.Request, docID uuid.UUID) bool {
	return h.requireOwnerTo(w, r, docID, "only the owner can manage access")
}

func (h *Handler) requireOwnerTo(w http.ResponseWriter, r *http.Request, docID uuid.UUID, forbidden string) bool {
	user, _ := auth.UserFrom(r.Context())
	role, err := h.store.RoleFor(r.Context(), docID, user.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "document not found")
	case err != nil:
		httpx.Internal(w, r, h.log, err)
	case role != RoleOwner:
		httpx.Error(w, http.StatusForbidden, forbidden)
	default:
		return true
	}
	return false
}

// listMembers: GET /documents/{id}/members (owner only, because it reveals
// members' email addresses).
func (h *Handler) listMembers(w http.ResponseWriter, r *http.Request) {
	docID, ok := docIDParam(w, r)
	if !ok || !h.requireOwner(w, r, docID) {
		return
	}
	members, err := h.store.ListMembers(r.Context(), docID)
	if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"members": members})
}

// removeMember: DELETE /documents/{id}/members/{userID} (owner only; the
// owner can't be removed). Open connections of that user to this document
// are closed (4003).
func (h *Handler) removeMember(w http.ResponseWriter, r *http.Request) {
	docID, ok := docIDParam(w, r)
	if !ok || !h.requireOwner(w, r, docID) {
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "member not found")
		return
	}
	switch err := h.store.RemoveMember(r.Context(), docID, userID); {
	case errors.Is(err, ErrNotFound):
		// The database says they are not a member. Close any connection
		// they still have anyway: an earlier attempt may have committed
		// and then failed to report it, skipping the hook (Week 5 review
		// H2). Closing a non-member's connection is always correct.
		h.live.MemberChanged(docID, userID, "")
		httpx.Error(w, http.StatusNotFound, "member not found")
	case errors.Is(err, ErrOwnerRole):
		httpx.Error(w, http.StatusConflict, "the owner cannot be removed")
	case err != nil:
		httpx.Internal(w, r, h.log, err)
	default:
		h.live.MemberChanged(docID, userID, "")
		w.WriteHeader(http.StatusNoContent)
	}
}

// rename: PATCH /documents/{id} {"title": "..."}. The owner and editors
// may rename; viewers get 403, non-members 404. Open editors see the new
// title when they next load the document.
func (h *Handler) rename(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	docID, ok := docIDParam(w, r)
	if !ok {
		return
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.WriteDecodeError(w, err)
		return
	}
	role, err := h.store.RoleFor(r.Context(), docID, user.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	case err != nil:
		httpx.Internal(w, r, h.log, err)
		return
	case role != RoleOwner && role != RoleEditor:
		httpx.Error(w, http.StatusForbidden, "only the owner and editors can rename this document")
		return
	}
	title, ok := validTitle(w, in.Title)
	if !ok {
		return
	}
	if err := h.store.Rename(r.Context(), docID, title); errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	} else if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	d, err := h.store.GetForUser(r.Context(), docID, user.ID)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"document": d})
}

// delete: DELETE /documents/{id}. Owner only (403 for other members, 404
// for non-members). Deletes the document, its history and its sharing, and
// closes everyone's open connection to it (4004).
func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	docID, ok := docIDParam(w, r)
	if !ok || !h.requireOwnerTo(w, r, docID, "only the owner can delete this document") {
		return
	}
	switch err := h.store.Delete(r.Context(), docID); {
	case errors.Is(err, ErrNotFound):
		h.live.Deleted(docID) // a retry after a lost response: close anything left
		httpx.Error(w, http.StatusNotFound, "document not found")
	case err != nil:
		httpx.Internal(w, r, h.log, err)
	default:
		h.live.Deleted(docID)
		w.WriteHeader(http.StatusNoContent)
	}
}

// validTitle trims the title and writes a 400 if it is empty or too long.
func validTitle(w http.ResponseWriter, raw string) (string, bool) {
	title := strings.TrimSpace(raw)
	if title == "" || utf8.RuneCountInString(title) > maxTitleRunes {
		httpx.Error(w, http.StatusBadRequest, "title must be 1 to 200 characters")
		return "", false
	}
	return title, true
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	var in struct {
		Title string `json:"title"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.WriteDecodeError(w, err)
		return
	}
	title, ok := validTitle(w, in.Title)
	if !ok {
		return
	}
	d, err := h.store.Create(r.Context(), user.ID, title)
	if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"document": d})
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	docs, err := h.store.ListForUser(r.Context(), user.ID)
	if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	ids := make([]uuid.UUID, len(docs))
	for i, d := range docs {
		ids[i] = d.ID
	}
	online := h.live.Online(ids)
	for i := range docs {
		docs[i].Online = online[docs[i].ID]
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"documents": docs})
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	docID, ok := docIDParam(w, r)
	if !ok {
		return
	}
	d, err := h.store.GetForUser(r.Context(), docID, user.ID)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		httpx.Internal(w, r, h.log, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"document": d})
}

// setMember: PUT /documents/{id}/members {"email": "...", "role": "editor"|"viewer"}.
// Only the owner may share; non-members get 404 (the document's existence
// is not revealed), other members 403.
func (h *Handler) setMember(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	if ok, retry := h.shareLimit.Allow(user.ID.String()); !ok {
		h.log.Warn("rate limited", "limit", "share_user")
		w.Header().Set("Retry-After", ratelimit.RetryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "too many attempts; please wait and try again")
		return
	}
	docID, ok := docIDParam(w, r)
	if !ok {
		return
	}
	var in struct {
		Email string `json:"email"`
		Role  Role   `json:"role"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.WriteDecodeError(w, err)
		return
	}

	role, err := h.store.RoleFor(r.Context(), docID, user.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	case err != nil:
		httpx.Internal(w, r, h.log, err)
		return
	case role != RoleOwner:
		httpx.Error(w, http.StatusForbidden, "only the owner can share this document")
		return
	}
	if in.Role != RoleEditor && in.Role != RoleViewer {
		httpx.Error(w, http.StatusBadRequest, `role must be "editor" or "viewer"`)
		return
	}
	email, err := auth.NormalizeEmail(in.Email)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "email must be a valid address")
		return
	}

	memberID, err := h.store.SetMember(r.Context(), docID, email, in.Role)
	switch {
	case errors.Is(err, ErrUserNotFound):
		httpx.Error(w, http.StatusNotFound, "no user with that email")
	case errors.Is(err, ErrOwnerRole):
		httpx.Error(w, http.StatusConflict, "the owner's role cannot be changed")
	case err != nil:
		httpx.Internal(w, r, h.log, err)
	default:
		h.live.MemberChanged(docID, memberID, in.Role)
		httpx.JSON(w, http.StatusOK, map[string]any{"member": map[string]any{"user_id": memberID, "role": in.Role}})
	}
}

func docIDParam(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "docID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "document not found")
		return uuid.Nil, false
	}
	return id, true
}
