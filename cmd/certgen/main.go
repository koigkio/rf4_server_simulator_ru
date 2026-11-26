// certgen создаёт и проверяет TLS-пару для готового архива сервера.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"rf4server/internal/gateway"
)

func main() {
	cert := flag.String("cert", "certs/server.crt", "Путь к сертификату")
	key := flag.String("key", "certs/server.key", "Путь к ключу")
	domain := flag.String("domain", "api.rf4game.ru", "Домен входа")
	flag.Parse()
	if err := gateway.EnsureCert(*cert, *key, *domain); err != nil {
		log.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(*cert, *key); err != nil {
		log.Fatal(err)
	}
}
