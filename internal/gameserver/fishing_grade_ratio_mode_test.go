package gameserver

import (
	"math"
	"testing"
)

// 饵效倍率不得改变四档比例；面板显示的占比就是实际发鱼的占比。
func TestGradeRatioSharesIgnoreBaitModeMultiplier(t *testing.T) {
	srv, db := newRigTestServer(t)
	enableGradeRatio(t, srv, db)
	setGradeRatioTunables(t, srv, db, map[string]string{
		"grade_pct_below":     "5.06",
		"grade_pct_qualified": "93.65",
		"grade_pct_trophy":    "1.19",
		"grade_pct_super":     "0.1",
	})
	lines := cachedGradeLines{val: ptrI64(1000), trophy: ptrI64(5000), blue: ptrI64(8000)}
	for _, mode := range []float64{1, 1.12, 1.36, 2} {
		weights, handled := srv.gradeRatioGradeWeights(lines, mode, 1, 0)
		if !handled {
			t.Fatalf("mode=%g 应有可用档位", mode)
		}
		total := weights[0] + weights[1] + weights[2] + weights[3]
		if math.Abs(weights[0]/total-.0506) > 1e-9 ||
			math.Abs(weights[1]/total-.9365) > 1e-9 ||
			math.Abs(weights[2]/total-.0119) > 1e-9 ||
			math.Abs(weights[3]/total-.001) > 1e-9 {
			t.Fatalf("mode=%g 改动了四档比例: %v", mode, weights)
		}
	}
}
