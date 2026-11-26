package gateway

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureCertRepairsInvalidPair(t *testing.T) {
	for _, tc := range []struct {
		name      string
		cert, key []byte
	}{
		{"corrupt", []byte("invalid certificate"), []byte("invalid key")},
		{"missing-key", []byte("old certificate"), nil},
		{"missing-cert", nil, []byte("old key")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			cert, key := filepath.Join(dir, "certs/server.crt"), filepath.Join(dir, "keys/server.key")
			for path, data := range map[string][]byte{cert: tc.cert, key: tc.key} {
				if data == nil {
					continue
				}
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := EnsureCert(cert, key, "api.rf4game.ru"); err != nil {
				t.Fatal(err)
			}
			pair, err := tls.LoadX509KeyPair(cert, key)
			if err != nil {
				t.Fatal(err)
			}
			leaf, err := x509.ParseCertificate(pair.Certificate[0])
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"api.rf4game.ru", "api.rf4game.com", "localhost", "127.0.0.1", "::1"} {
				if err := leaf.VerifyHostname(name); err != nil {
					t.Fatal(err)
				}
			}
			for path, data := range map[string][]byte{cert: tc.cert, key: tc.key} {
				backups, err := filepath.Glob(path + ".invalid-*")
				if err != nil {
					t.Fatal(err)
				}
				if data == nil {
					if len(backups) != 0 {
						t.Fatal(backups)
					}
					continue
				}
				if len(backups) != 1 {
					t.Fatalf("backups=%v", backups)
				}
				got, err := os.ReadFile(backups[0])
				if err != nil || !bytes.Equal(got, data) {
					t.Fatalf("backup=%q err=%v", got, err)
				}
			}
		})
	}
}

func TestEnsureCertPreservesValidPair(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	if err := EnsureCert(cert, key, "api.rf4game.ru"); err != nil {
		t.Fatal(err)
	}
	beforeCert, _ := os.ReadFile(cert)
	beforeKey, _ := os.ReadFile(key)
	if err := EnsureCert(cert, key, "api.rf4game.ru"); err != nil {
		t.Fatal(err)
	}
	afterCert, _ := os.ReadFile(cert)
	afterKey, _ := os.ReadFile(key)
	if !bytes.Equal(beforeCert, afterCert) || !bytes.Equal(beforeKey, afterKey) {
		t.Fatal("valid TLS pair was replaced")
	}
}

func TestEnsureCertRejectsSamePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.pem")
	if err := EnsureCert(path, path, "localhost"); err == nil {
		t.Fatal("expected error")
	}
}

func TestEnsureCertRepairsExplicitECDSAParameters(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	if err := EnsureCert(cert, key, "localhost"); err != nil {
		t.Fatal(err)
	}
	// Публичный тестовый сертификат OpenSSL с explicit EC parameters.
	invalid, err := os.ReadFile("testdata/explicit-ec.pem")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cert, invalid, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(cert, key); err == nil || !strings.Contains(err.Error(), "invalid ECDSA parameters") {
		t.Fatalf("expected original ECDSA failure, got %v", err)
	}
	if err := EnsureCert(cert, key, "localhost"); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		t.Fatal(err)
	}
}
