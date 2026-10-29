// Package migrations embeds the Goose SQL migrations so the binary and the
// tests apply exactly the same files.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
