package gateway

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// EnsureCert проверяет пару TLS и создаёт самоподписанный сертификат при её отсутствии.
// Повреждённые файлы сохраняются перед заменой; новый сертификат нужно установить заново.
func EnsureCert(certFile, keyFile, loginDomain string) error {
	if certFile == "" || keyFile == "" {
		return fmt.Errorf("Не указан путь к сертификату")
	}
	if filepath.Clean(certFile) == filepath.Clean(keyFile) {
		return fmt.Errorf("Сертификат и ключ должны храниться в разных файлах")
	}
	var existing []string
	for _, path := range []string{certFile, keyFile} {
		if _, err := os.Stat(path); err == nil {
			existing = append(existing, path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("Проверка TLS-файла %s: %w", path, err)
		}
	}
	if len(existing) == 2 {
		if _, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
			return nil
		}
	}
	// Сначала копируем все исходные файлы. Ошибка резервирования не должна
	// приводить к перезаписи сертификата или ключа.
	backupSuffix := ".invalid-" + time.Now().UTC().Format("20060102T150405.000000000")
	for _, path := range existing {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("Чтение TLS-файла %s: %w", path, err)
		}
		backup, err := os.OpenFile(path+backupSuffix, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return fmt.Errorf("Резервная копия TLS-файла %s: %w", path, err)
		}
		_, writeErr := backup.Write(data)
		closeErr := backup.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			return fmt.Errorf("Резервная копия TLS-файла %s: %w", path, err)
		}
	}
	if len(existing) > 0 {
		slog.Warn("Некорректная или неполная пара TLS сохранена в резервные копии; после восстановления установите новый сертификат в доверенные корневые центры", "cert", certFile, "backup_suffix", backupSuffix)
	}
	for _, path := range []string{certFile, keyFile} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: loginDomain},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              certDNSNames(loginDomain),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certFile, certPEM, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return err
	}
	return nil
}

// certDNSNames — имена в сертификате: основной домен входа, оба официальных
// домена RF4 (клиент Steam может входить через api.rf4game.com) и localhost.
func certDNSNames(loginDomain string) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, n := range []string{loginDomain, "api.rf4game.ru", "api.rf4game.com", "localhost"} {
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		names = append(names, n)
	}
	return names
}
