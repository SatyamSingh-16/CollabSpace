// Command healthcheck probes the server's readiness endpoint and exits 0 if
// it answers 200. It exists for container health checks: the runtime image
// (distroless) has no shell or curl.
//
//	healthcheck [url]   default http://127.0.0.1:8080/readyz
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	url := "http://127.0.0.1:8080/readyz"
	if len(os.Args) > 1 {
		url = os.Args[1]
	}
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unhealthy:", err)
		os.Exit(1)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "unhealthy: status", res.StatusCode)
		os.Exit(1)
	}
}
