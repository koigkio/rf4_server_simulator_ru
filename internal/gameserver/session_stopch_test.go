package gameserver

import (
	"testing"

	"rf4server/internal/config"
	"rf4server/internal/logging"
)

// 手工构造的会话（测试探针会话）没有 stopCh：
// 关闭它不能 panic，且关闭信号必须真的生效。
func TestSessionCloseWithoutStopChannel(t *testing.T) {
	srv := NewServer(config.Game{}, logging.Discard(), nil)
	sess := &Session{ID: 1, Userid: 1000001, Srv: srv, log: logging.Discard()}

	sess.Close("test_missing_stop_ch")

	if !sess.Closed() {
		t.Fatal("会话未标记为已关闭")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("关闭信号没有生效")
	}
}

// 裸会话（连 Srv 和 log 都没有）关闭时也不能 panic。
func TestSessionCloseBareSession(t *testing.T) {
	sess := &Session{}

	sess.Close("test_bare_session")

	if !sess.Closed() {
		t.Fatal("会话未标记为已关闭")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("关闭信号没有生效")
	}
}

// 没关闭过的会话，Done 也要给出可用通道（nil 通道会让 select 永远不触发）。
func TestSessionDoneChannelIsUsable(t *testing.T) {
	sess := &Session{}
	if sess.Done() == nil {
		t.Fatal("Done 返回了 nil 通道")
	}
}
