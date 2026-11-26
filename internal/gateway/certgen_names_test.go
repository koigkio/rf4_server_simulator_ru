package gateway

import (
	"slices"
	"testing"
)

func TestCertDNSNamesCoverBothOfficialDomains(t *testing.T) {
	got := certDNSNames("api.rf4game.ru")
	for _, want := range []string{"api.rf4game.ru", "api.rf4game.com", "localhost"} {
		if !slices.Contains(got, want) {
			t.Fatalf("certDNSNames=%v, нет %q", got, want)
		}
	}
	if len(got) != 3 {
		t.Fatalf("дубликаты в %v", got)
	}
}
