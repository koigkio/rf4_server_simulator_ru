// Package names переводит отображаемые названия рыб, водоёмов и наживок
// с китайского на русский.
//
// В статической базе (server_data/static.sqlite3) названия хранятся
// по-китайски и служат ключами: правила наживки, ассистент поиска и записи
// уловов сопоставляют их напрямую. Поэтому база не меняется, а перевод
// делается только при показе игроку и в админ-панели.
package names

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"unicode"
)

//go:embed names_ru.json
var raw []byte

var (
	once     sync.Once
	exact    map[string]string
	replacer *strings.Replacer
)

func load() {
	exact = map[string]string{}
	if err := json.Unmarshal(raw, &exact); err != nil {
		panic("names: повреждён names_ru.json: " + err.Error())
	}
	keys := make([]string, 0, len(exact))
	for k := range exact {
		keys = append(keys, k)
	}
	// Длинные ключи первыми: strings.Replacer при совпадении в одной позиции
	// выбирает пару, переданную раньше, — так «拉多加湖群岛» не превратится
	// в «Ладожское озеро群岛».
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) != len(keys[j]) {
			return len(keys[i]) > len(keys[j])
		}
		return keys[i] < keys[j]
	})
	pairs := make([]string, 0, len(keys)*2)
	for _, k := range keys {
		pairs = append(pairs, k, exact[k])
	}
	replacer = strings.NewReplacer(pairs...)
}

// Ru возвращает русское название для китайского названия рыбы, водоёма или
// наживки. Составные названия («蜂蜜 20; 甜玉米 25») переводятся по частям,
// если в словаре нашлись все части; иначе возвращается исходная строка.
// Строки без китайских символов возвращаются как есть.
func Ru(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\ufeff", ""))
	if !hasHan(s) {
		return s
	}
	once.Do(load)
	if v, ok := exact[s]; ok {
		return v
	}
	// Составное название переводим, только если перевелось целиком: смесь
	// вроде «捕获Червь» читается хуже, чем исходник.
	if out := replacer.Replace(s); !hasHan(out) {
		return out
	}
	return s
}

// All отдаёт копию словаря (для админ-панели).
func All() map[string]string {
	once.Do(load)
	out := make(map[string]string, len(exact))
	for k, v := range exact {
		out[k] = v
	}
	return out
}

func hasHan(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// Search возвращает китайские названия, у которых русский перевод содержит
// query (без учёта регистра). Нужен, чтобы поиск в админ-панели по-русски
// находил записи, которые в базе хранятся по-китайски. Не больше limit штук.
func Search(query string, limit int) []string {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" || hasHan(query) {
		return nil
	}
	once.Do(load)
	var out []string
	for zh, ru := range exact {
		if strings.Contains(strings.ToLower(ru), query) {
			out = append(out, zh)
		}
	}
	sort.Strings(out)
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// SQLAnyLike строит фрагмент «OR col LIKE ? OR …» для найденных Search
// названий и соответствующие аргументы. Пустая строка — совпадений нет.
func SQLAnyLike(col string, zh []string) (string, []any) {
	if len(zh) == 0 {
		return "", nil
	}
	var b strings.Builder
	args := make([]any, 0, len(zh))
	for _, z := range zh {
		b.WriteString(" OR " + col + " LIKE ?")
		args = append(args, "%"+z+"%")
	}
	return b.String(), args
}
