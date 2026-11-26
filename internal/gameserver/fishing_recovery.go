package gameserver

import (
	"errors"
	"rf4server/internal/store"
)

func completedCatchPending(st *FishState) bool {
	return st.Pending != nil && st.Hooked && !st.CastActive && !st.Resolved
}

func (s *Server) pendingCatchAllowsCast(ctx *Ctx, st *FishState) bool {
	if err := s.recoverCompletedCatch(ctx.Sess.Userid, ctx.Sess); err != nil {
		message := "Ожидающий улов ещё не помещён в садок, попробуйте позже"
		if errors.Is(err, store.ErrKeepnetFull) {
			message = "Садок полон — освободите место, и ожидающий улов попадёт в садок автоматически"
		}
		ctx.ReplyFailure("System.InvalidOperationException", message)
		return false
	}
	blocked := false
	for _, rod := range s.fishingStatesFor(ctx.Sess.Userid) {
		rod.mu.Lock()
		blocked = blocked || completedCatchPending(rod)
		rod.mu.Unlock()
	}
	if blocked {
		ctx.ReplyFailure("System.InvalidOperationException", "Сначала поместите текущий улов в садок или отпустите")
	}
	return !blocked
}
