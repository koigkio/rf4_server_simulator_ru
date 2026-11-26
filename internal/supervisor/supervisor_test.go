package supervisor

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestNewSupervisesOnlyGameServices(t *testing.T) {
	s := New(t.TempDir(), "config.yaml", "")
	status := s.Status()
	if len(status) != 2 {
		t.Fatalf("process count=%d, want 2", len(status))
	}
	want := []string{"gameserver", "gateway"}
	for i, name := range want {
		if status[i].Name != name {
			t.Fatalf("status[%d]=%q, want %q", i, status[i].Name, name)
		}
	}
}

// Запускается только в дочернем тестовом процессе.
func TestSupervisorExitHelper(t *testing.T) {
	if slices.Contains(os.Args, "supervisor-exit-helper") {
		os.Exit(1)
	}
}

func TestSuperviseStopsAfterRepeatedFailures(t *testing.T) {
	for _, missing := range []bool{false, true} {
		name := "crash"
		if missing {
			name = "missing-executable"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			s := New(filepath.Dir(exe), "", "")
			p := &proc{spec: Spec{Name: "test", ExeName: filepath.Base(exe), Args: []string{"-test.run=^TestSupervisorExitHelper$", "--", "supervisor-exit-helper"}}}
			if err := s.launch(p); err != nil {
				t.Fatal(err)
			}
			if missing {
				p.spec.ExeName = "missing-executable"
			}
			s.supervise(p)
			if p.state != StateFailed {
				t.Fatalf("state=%s", p.state)
			}
			if p.fails != maxConsecFails+1 {
				t.Fatalf("failures=%d", p.fails)
			}
		})
	}
}
