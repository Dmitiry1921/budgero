package shared //nolint:revive // var-naming: tests access unexported helpers in the shared command package

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestSetPWAHeadersDoesNotCacheHTMLShell(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{name: "root shell", path: "/index.html", want: "no-cache, no-store, must-revalidate"},
		{name: "hashed asset", path: "/assets/index-abc123.js", want: "public, max-age=31536000"},
		{name: "service worker", path: "/sw.js", want: "no-cache, no-store, must-revalidate"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			ctx := e.NewContext(httptest.NewRequest(http.MethodGet, tt.path, http.NoBody), httptest.NewRecorder())

			setPWAHeaders(ctx, tt.path)

			if got := ctx.Response().Header().Get("Cache-Control"); got != tt.want {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.want)
			}
		})
	}
}
