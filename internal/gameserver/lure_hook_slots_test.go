package gameserver

import (
	"database/sql"
	"errors"
	"reflect"
	"slices"
	"testing"

	"rf4server/internal/proto"
)

func TestLureHookSlotsPurchasedLureWithoutPositionRecord(t *testing.T) {
	s := newSkillsCraftServer(t, openRecipeTestDB(t))
	if _, err := s.DB.EnsureProfile(t.Context(), craftLureTestUID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.SQL.Exec(`UPDATE profile SET silver=200000 WHERE uid=?`, craftLureTestUID); err != nil {
		t.Fatal(err)
	}
	const model = "crank_f_1876"
	if _, err := s.DB.SQL.Exec(`INSERT INTO shop_item(store_id,item_id,silver,gold,stock) VALUES('shop',?,1000,0,10)`, model); err != nil {
		t.Fatal(err)
	}
	c := economyTestCtx(s, craftLureTestUID, proto.Args524(proto.StrVal("shop"), proto.StrVal(model), proto.U64(999999)))
	c.ExpectResponse = true
	c.replyCapture = &ctxReplyCapture{}
	body, ok := hStoreBuy(false)(c)
	if !ok || len(body) == 0 {
		t.Fatal("purchase failed")
	}
	result := decodeTreeValue(t, s, body)
	var guid string
	if err := s.DB.SQL.QueryRow(`SELECT guid FROM item WHERE uid=? AND item_id=?`, craftLureTestUID, model).Scan(&guid); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.DB.KVGet(t.Context(), lureHookPositionsKey+guid); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("purchased lure should have no position record: %v", err)
	}
	want := lureTestHooks(t, s, guid)
	if len(want) == 0 {
		t.Fatal("fixture has no factory hooks")
	}
	t.Run("purchase-response", func(t *testing.T) {
		list := result.Fields[1].Val
		if list == nil || list.Kind != proto.KindArgs || len(list.Items) != 1 || treeRootGUID(list.Items[0]) != guid {
			t.Fatal("purchase response omitted the purchased lure")
		}
		assertLureWireSlots(t, list.Items[0], want)
	})
	t.Run("inventory-details", func(t *testing.T) {
		ctx := economyTestCtx(s, craftLureTestUID, proto.Args524(proto.U32(0), proto.GuidArr([]string{guid})))
		body, ok := hItemDetails(ctx)
		if !ok {
			t.Fatal("inventory details failed")
		}
		list := decodeTreeValue(t, s, body)
		if len(list.Items) != 1 || treeRootGUID(list.Items[0]) != guid {
			t.Fatal("inventory details omitted the purchased lure")
		}
		assertLureWireSlots(t, list.Items[0], want)
	})
	t.Run("reload", func(t *testing.T) {
		assertLureSlotReload(t, s, guid, want)
	})
}

func assertLureWireSlots(t *testing.T, tree *proto.Value, want []string) {
	t.Helper()
	list := tree.Fields[lureHookFieldIndex(tree.Class)].Val
	if list == nil || list.Kind != proto.KindArgs || list.Code == nil || *list.Code != "60" || len(list.Items) != len(want) {
		t.Fatalf("expected args(60) with %d positions: %+v", len(want), list)
	}
	for i, guid := range want {
		if guid == "" {
			if list.Items[i] == nil || list.Items[i].Kind != proto.KindNull {
				t.Fatalf("slot %d must be an explicit null value", i)
			}
		} else if list.Items[i].Kind != proto.KindObj || lureHookItemGUID(list.Items, i) != guid {
			t.Fatalf("slot %d does not contain %s", i, guid)
		}
	}
}

func assertLureSlotReload(t *testing.T, s *Server, guid string, want []string) {
	t.Helper()
	row, err := s.DB.GetItemByGUID(t.Context(), guid)
	if err != nil {
		t.Fatal(err)
	}
	before := row.FieldsJSON
	tree, err := s.ItemToTree(t.Context(), row)
	if err != nil {
		t.Fatal(err)
	}
	body, err := proto.EncodeValue(tree, s.Table())
	if err != nil {
		t.Fatal(err)
	}
	assertLureWireSlots(t, decodeTreeValue(t, s, body), want)
	fresh, err := s.DB.GetItemByGUID(t.Context(), guid)
	if err != nil || fresh.FieldsJSON != before {
		t.Fatal("wire projection mutated persisted fields", err)
	}
	fields, err := FieldsFromJSON(fresh.FieldsJSON)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range fields[lureHookFieldIndex(row.WireClass)].Val.Items {
		if item == nil || item.Kind != proto.KindObj {
			t.Fatal("empty slot leaked into persisted hook objects")
		}
	}
}

func TestLureHookSlotsTransfers(t *testing.T) {
	for _, removed := range []int{0, 1} {
		t.Run([]string{"first", "second"}[removed], func(t *testing.T) {
			s, materials := craftLureTestSetup(t)
			guid := treeRootGUID(craftLureTestRequest(t, s, materials, true).Fields[1].Val.Items[0])
			hooks := []string{craftLureTestHook(t, s, "plug_hook", "triple_20124").GUID, craftLureTestHook(t, s, "plug_hook_2", "triple_20125").GUID}
			want := []string{"", ""}
			// Fill slot 1 first: compact storage order differs from client slot order.
			for _, i := range []int{1, 0} {
				res := s.lureHookMount(t.Context(), craftLureTestUID, guid, hooks[i], int64(i))
				if res.Rejected {
					t.Fatal("installation rejected")
				}
				want[i] = hooks[i]
				for _, tree := range res.UpdatedTrees {
					if treeRootGUID(tree) == guid {
						assertLureWireSlots(t, tree, want)
					}
				}
				assertLureSlotReload(t, s, guid, want)
			}
			spare := craftLureTestHook(t, s, "plug_hook", "triple_20124")
			if res := s.lureHookMount(t.Context(), craftLureTestUID, guid, spare.GUID, 2); !res.Rejected {
				t.Fatal("out-of-range slot accepted")
			}
			if _, err := s.DB.SQL.Exec(`CREATE TRIGGER fail_empty_slot_update BEFORE UPDATE ON item WHEN OLD.wire_class='ioombppcnlh' BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
				t.Fatal(err)
			}
			if !s.lureHookMount(t.Context(), craftLureTestUID, guid, spare.GUID, int64(removed)).Rejected {
				t.Fatal("failed mount accepted")
			}
			unmounted, err := s.DB.GetItemByGUID(t.Context(), spare.GUID)
			if err != nil || unmounted.Container != "backpack" || unmounted.RigGUID != "" {
				t.Fatal("failed mount changed ownership", err)
			}
			if s.lureHookRemove(t.Context(), craftLureTestUID, guid, hooks[removed], int64(removed)) != nil {
				t.Fatal("failed removal accepted")
			}
			assertLureSlotReload(t, s, guid, hooks)
			assertLurePositions(t, s, guid, hooks)
			stillMounted, err := s.DB.GetItemByGUID(t.Context(), hooks[removed])
			if err != nil || stillMounted.Container != "rig" || stillMounted.RigGUID != guid {
				t.Fatal("failed removal changed ownership", err)
			}
			if _, err := s.DB.SQL.Exec(`DROP TRIGGER fail_empty_slot_update`); err != nil {
				t.Fatal(err)
			}
			// Omitted GUID exercises slot -> compact index translation for removal.
			res := s.lureHookRemove(t.Context(), craftLureTestUID, guid, "", int64(removed))
			if res == nil || res.CompGUID != hooks[removed] {
				t.Fatalf("removed wrong slot: %+v", res)
			}
			want[removed] = ""
			assertLureSlotReload(t, s, guid, want)
			returned, err := s.DB.GetItemByGUID(t.Context(), hooks[removed])
			if err != nil || returned.Container != "backpack" || returned.RigGUID != "" || returned.Qty != 1 {
				t.Fatal("removed hook ownership", returned, err)
			}
			if s.lureHookRemove(t.Context(), craftLureTestUID, guid, "", int64(removed)) != nil {
				t.Fatal("empty slot removal accepted")
			}
			if s.lureHookMount(t.Context(), craftLureTestUID, guid, returned.GUID, int64(removed)).Rejected {
				t.Fatal("reinstallation rejected")
			}
			assertLureSlotReload(t, s, guid, hooks)
			// Replace an occupied stable slot after storage order has changed.
			replacement := craftLureTestHook(t, s, "plug_hook", "triple_20124")
			if s.lureHookMount(t.Context(), craftLureTestUID, guid, replacement.GUID, int64(1-removed)).Rejected {
				t.Fatal("replacement rejected")
			}
			want = slices.Clone(hooks)
			want[1-removed] = replacement.GUID
			assertLureSlotReload(t, s, guid, want)
			old, err := s.DB.GetItemByGUID(t.Context(), hooks[1-removed])
			if err != nil || old.Container != "backpack" || old.RigGUID != "" {
				t.Fatal("replaced wrong hook", err)
			}
		})
	}
}

func TestLureHookSlotsConcurrentMount(t *testing.T) {
	s, materials := craftLureTestSetup(t)
	guid := treeRootGUID(craftLureTestRequest(t, s, materials, true).Fields[1].Val.Items[0])
	a := craftLureTestHook(t, s, "plug_hook_2", "triple_20124")
	b := craftLureTestHook(t, s, "plug_hook_2", "triple_20125")
	plan := s.lureHookMountPrepare(t.Context(), craftLureTestUID, guid, a.GUID, 1)
	if plan == nil || s.lureHookMount(t.Context(), craftLureTestUID, guid, b.GUID, 1).Rejected {
		t.Fatal("setup failed")
	}
	before, err := s.DB.ListItemsByContainers(t.Context(), craftLureTestUID, []string{"backpack", "rig"})
	if err != nil {
		t.Fatal(err)
	}
	if !s.lureHookMountCommit(t.Context(), plan).Rejected {
		t.Fatal("stale plan accepted")
	}
	after, err := s.DB.ListItemsByContainers(t.Context(), craftLureTestUID, []string{"backpack", "rig"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("rejected mount changed inventory")
	}
	assertLureSlotReload(t, s, guid, []string{"", b.GUID})
}

func TestLureHookSlotsMountedTreeWithEmptyFirstSlot(t *testing.T) {
	s, db := newDetachTestServer(t)
	const uid = int64(1000001)
	rod, err := s.CreateItem(t.Context(), uid, "spin_10032_S60L", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	lure, err := s.CreateItem(t.Context(), uid, "topwater_1928", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	hooks := lureTestHooks(t, s, lure.GUID)
	if len(hooks) != 2 {
		t.Fatal("fixture must have two factory hooks")
	}
	mountLure(t, db, s, rod.GUID, lure.GUID)
	if s.lureHookRemove(t.Context(), uid, lure.GUID, hooks[0], 0) == nil {
		t.Fatal("first hook removal failed")
	}
	tree := s.buildMountedHookTree(t.Context(), rod.GUID)
	if tree == nil || tree.Class != lureWireClass {
		t.Fatal("mounted hook frame must retain the lure container")
	}
	assertLureWireSlots(t, tree, []string{"", hooks[1]})
	sub := s.mountedHookSubTree(t.Context(), rod.GUID, hooks[1])
	if sub == nil || sub.Class != "agedjipcnpe" || treeRootGUID(sub) != hooks[1] {
		t.Fatal("hook physics lookup must skip empty slots and find the real hook")
	}
}
