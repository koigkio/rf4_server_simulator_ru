package gameserver

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"github.com/mozillazg/go-pinyin"

	"rf4server/internal/names"
)

func fishQueryName(text string) string {
	return strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
}

func fishQueryPinyin(text string) string {
	args := pinyin.Args{
		Style: pinyin.Normal,
		// Preserve Latin pinyin and unknown characters instead of dropping them.
		Fallback: func(r rune, _ pinyin.Args) []string { return []string{string(r)} },
	}
	return strings.Join(pinyin.LazyPinyin(strings.ToLower(text), args), "")
}

func (s *Server) resolveFishQuerySpecies(ctx context.Context, text string) (string, error) {
	text = fishQueryName(text)
	lower := strings.ToLower(text)
	prefix := fishQueryPinyin(text)
	if prefix == "" {
		return "", fmt.Errorf("Вид рыбы не найден, введите название, начало названия или номер вида")
	}
	rows, err := s.DB.SQL.QueryContext(ctx, `SELECT DISTINCT fish_key,COALESCE(fish_zh,'') FROM loc_wiki_fish ORDER BY fish_key,fish_zh`)
	if err != nil {
		return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
	}
	defer rows.Close()
	first := ""
	for rows.Next() {
		var key, name string
		if err := rows.Scan(&key, &name); err != nil {
			return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
		}
		name = fishQueryName(name)
		ru := strings.ToLower(names.Ru(name))
		if text == key || text == name || lower == ru {
			return key, nil
		}
		// Keep the first prefix match, but let an exact name or key take priority.
		if first == "" && (strings.HasPrefix(fishQueryPinyin(name), prefix) || (lower != "" && fishQueryWordPrefix(ru, lower))) {
			first = key
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
	}
	if first != "" {
		return first, nil
	}
	return "", fmt.Errorf("Вид рыбы не найден, введите название, начало названия или номер вида")
}

func (s *Server) resolveFishQueryMap(ctx context.Context, text string) (string, error) {
	if key, ok := s.resolveFishQueryMapRu(ctx, text); ok {
		return key, nil
	}
	rows, err := s.DB.SQL.QueryContext(ctx, `SELECT alias FROM loc_alias WHERE alias=? OR loc=? ORDER BY alias LIMIT 2`, text, text)
	if err != nil {
		return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("Данные о виде рыбы или карте пока недоступны")
	}
	if len(keys) == 1 {
		return keys[0], nil
	}
	return "", fmt.Errorf("Карта не распознана, используйте полное название карты или номер level")
}

// fishQueryHelpWords и fishQueryCommandWords — русские и прежние китайские
// команды ассистента: старые привычки игроков продолжают работать.
var (
	fishQueryHelpWords    = []string{"помощь", "меню", "справка", "help", "帮助", "菜单"}
	fishQueryCommandWords = []string{"рыба", "поиск", "найти", "查鱼", "查询"}
)

func fishQueryIsHelp(text string) bool {
	text = strings.ToLower(strings.TrimSpace(text))
	for _, w := range fishQueryHelpWords {
		if text == w {
			return true
		}
	}
	return false
}

func fishQueryIsCommand(word string) bool {
	word = strings.ToLower(word)
	for _, w := range fishQueryCommandWords {
		if word == w {
			return true
		}
	}
	return false
}

// fishQueryWordPrefix: запрос — начало названия или начало любого слова в нём
// («плотва» находит «Плотва обыкновенная», «тунг» — «Река Нижняя Тунгуска»).
func fishQueryWordPrefix(name, query string) bool {
	if query == "" {
		return false
	}
	if strings.HasPrefix(name, query) {
		return true
	}
	for _, w := range strings.Fields(name) {
		if strings.HasPrefix(w, query) {
			return true
		}
	}
	return false
}

// resolveFishQueryArgs разбирает «рыба [карта]», где и рыба, и карта могут
// состоять из нескольких слов. Сначала пробуется самое длинное название рыбы.
func (s *Server) resolveFishQueryArgs(ctx context.Context, args []string, currentMap string) (string, string, error) {
	var firstErr error
	for i := len(args); i >= 1; i-- {
		fish, err := s.resolveFishQuerySpecies(ctx, strings.Join(args[:i], " "))
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if i == len(args) {
			return fish, currentMap, nil
		}
		mapKey, err := s.resolveFishQueryMap(ctx, strings.Join(args[i:], " "))
		if err != nil {
			firstErr = err
			continue
		}
		return fish, mapKey, nil
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("Вид рыбы не найден, введите название, начало названия или номер вида")
	}
	return "", "", firstErr
}

// resolveFishQueryMapRu ищет карту по русскому названию («Нижняя Тунгуска»,
// «озеро Медное», «тунг»). Совпадение должно быть однозначным.
func (s *Server) resolveFishQueryMapRu(ctx context.Context, text string) (string, bool) {
	query := strings.ToLower(strings.TrimSpace(text))
	if query == "" {
		return "", false
	}
	rows, err := s.DB.SQL.QueryContext(ctx, `SELECT alias, loc FROM loc_alias ORDER BY alias`)
	if err != nil {
		return "", false
	}
	defer rows.Close()
	var exact, partial []string
	for rows.Next() {
		var key, loc string
		if err := rows.Scan(&key, &loc); err != nil {
			return "", false
		}
		ru := strings.ToLower(names.Ru(loc))
		if ru == loc {
			continue
		}
		short := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(ru, "озеро "), "река "))
		switch {
		case query == ru || query == short:
			exact = append(exact, key)
		case strings.Contains(ru, query) || fishQueryWordPrefix(ru, query):
			partial = append(partial, key)
		}
	}
	if len(exact) == 1 {
		return exact[0], true
	}
	if len(exact) == 0 && len(partial) == 1 {
		return partial[0], true
	}
	return "", false
}
