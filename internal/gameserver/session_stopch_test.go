package gameserver

import (
	"sync"
	"testing"
	"time"

	"rf4server/internal/config"
	"rf4server/internal/logging"
)

// 手工构造的会话（测试探针会话）没有 stopCh：
// 关闭它不能 panic，且关闭信号必须真的生效。
func TestSessionCloseWithoutStopChannel(t *testing.T) {
	srv := NewServer(config.Game{}, logging.Discard(), nil)
	sess := &Session{
		ID:     1,
		Token:  "session-stopch-test",
		Userid: 1000001,
		Srv:    srv,
		log:    logging.Discard(),
	}
	// 按真实会话生命周期注册并计数，避免 Close -> removeSession 把未计数的
	// 全局在线会话 Gauge 递减成负数。
	srv.mu.Lock()
	srv.sessions[sess.ID] = sess
	srv.byToken[sess.Token] = sess
	srv.mu.Unlock()
	gsSessionsActive.Add(1)

	sess.Close("test_missing_stop_ch")

	if !sess.Closed() {
		t.Fatal("会话未标记为已关闭")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("关闭信号没有生效")
	}
	if srv.byID(sess.ID) != nil {
		t.Fatal("会话关闭后仍留在注册表中")
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

// 生产路径可能从隧道关闭、发送失败、重连接管和服务器关闭等多处并发调用
// Close；同时 Done/Closed 也可能在保活循环和业务 goroutine 中并发读取。
func TestSessionConcurrentCloseDoneClosed(t *testing.T) {
	sess := &Session{}
	const workers = 64
	start := make(chan struct{})
	panicCh := make(chan any, workers)
	timeoutCh := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			<-start
			defer func() {
				if r := recover(); r != nil {
					panicCh <- r
				}
			}()
			sess.Close("test_concurrent")
		}()
		go func() {
			defer wg.Done()
			<-start
			select {
			case <-sess.Done():
			case <-time.After(2 * time.Second):
				timeoutCh <- struct{}{}
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			_ = sess.Closed()
		}()
	}

	close(start)
	wg.Wait()
	close(panicCh)
	close(timeoutCh)

	for r := range panicCh {
		t.Errorf("并发 Close panic: %v", r)
	}
	for range timeoutCh {
		t.Error("Done 未在超时前关闭")
	}
	if !sess.Closed() {
		t.Fatal("并发关闭后会话未标记为已关闭")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("并发关闭后 Done 未关闭")
	}

	// 再重复关闭若干次，覆盖 CAS 之后所有调用都直接返回的路径。
	for i := 0; i < workers; i++ {
		sess.Close("test_repeat")
	}
}
