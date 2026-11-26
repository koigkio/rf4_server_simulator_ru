package names

import "testing"

func TestRu(t *testing.T) {
	cases := map[string]string{
		"丁鱥\ufeff":      "Линь",
		"拉多加湖群岛":        "Ладожский архипелаг",
		"拉多加湖":          "Ладожское озеро",
		"蜂蜜 20; 甜玉米 25": "Мёд 20; Сладкая кукуруза 25",
		"Spiker #2 系列":  "Spiker #2 (серия)",
		"perch":         "perch",
		"":              "",
	}
	for in, want := range cases {
		if got := Ru(in); got != want {
			t.Errorf("Ru(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestSearch(t *testing.T) {
	got := Search("щук", 10)
	found := false
	for _, zh := range got {
		if Ru(zh) == "Щука обыкновенная" {
			found = true
		}
	}
	if !found {
		t.Fatalf("Search(щук)=%v", got)
	}
	if Search("", 10) != nil || Search("狗鱼", 10) != nil {
		t.Fatal("empty or Chinese query must not expand")
	}
	frag, args := SQLAnyLike("c.name", []string{"蚯蚓"})
	if frag != " OR c.name LIKE ?" || len(args) != 1 || args[0] != "%蚯蚓%" {
		t.Fatalf("frag=%q args=%v", frag, args)
	}
}
