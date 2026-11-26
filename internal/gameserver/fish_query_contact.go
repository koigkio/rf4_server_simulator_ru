package gameserver

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"rf4server/internal/names"
	"rf4server/internal/proto"
)

// The assistant is a virtual contact, not a player account or an administrator.
const fishQueryContactUID int64 = 2147483647
const fishQueryContactName = "Помощник по рыбе"

func hSocialMembers(ctx *Ctx) ([]byte, bool) {
	s := ctx.Sess.Srv
	ids := []uint32{uint32(fishQueryContactUID), uint32(gearAssistantUID)}
	seen := map[int64]bool{fishQueryContactUID: true, gearAssistantUID: true}
	s.mu.Lock()
	for _, peer := range s.sessions {
		if peer != nil && !peer.Closed() && peer.Userid > 0 && !seen[peer.Userid] {
			ids = append(ids, uint32(peer.Userid))
			seen[peer.Userid] = true
		}
	}
	s.mu.Unlock()
	sort.Slice(ids[2:], func(i, j int) bool { return ids[i+2] < ids[j+2] })
	return encodeSocialTree(ctx, proto.U32Arr(ids))
}

const fishQueryHelp = "Отправьте: название рыбы [карта]\nНапример: окунь или окунь Нижняя Тунгуска.\nНазвание рыбы можно вводить по началу слова — по-русски, по-китайски или пиньинем; при нескольких совпадениях берётся первое.\nПо умолчанию — текущая карта, рекомендации сгруппированы по спиннингу, поплавку и донке, до трёх вариантов в группе (зона, наживка и способ). Поддерживаются только карты с проверенными координатами; теоретическая скорость рыб/час оценивается по текущим условиям, без ожидания клиента, это не реальный улов.\nЗапрос обычно выполняется быстро; для сложных карт закладывайте около 3 секунд, ответ придёт личным сообщением.\n\n" +
	"Как считается: одна снасть, одна наживка без прикормки, сначала грубый отбор зон, затем подбор наживки — лучший вариант на всей карте не гарантируется. Оценка зон не учитывает глубину, дно и течение в каждой точке.\n" +
	"Вода/суша: если есть данные карты, проверяются центр и четыре угла, зона остаётся при воде хотя бы в одной точке; смешанные клетки могут содержать сушу, достижимость не гарантирована. Без данных карты суша не исключается.\n" +
	"Теоретическая скорость не учитывает ожидание клиента, занятость снасти, вываживание, вытаскивание, перезаброс и защиту при погружении; это не реальный улов и не прогноз на час."
const fishQueryBudget = 3 * time.Second
const fishQueryTimeoutReply = "Время запроса истекло (лимит расчёта 3 секунды), попробуйте позже."

func (s *Server) fishQueryReply(ctx context.Context, sess *Session, text string) (reply string) {
	defer func() {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			reply = fishQueryTimeoutReply
		}
	}()
	args := strings.Fields(text)
	if len(args) == 0 || fishQueryIsHelp(text) {
		return fishQueryHelp
	}
	if fishQueryIsCommand(args[0]) {
		args = args[1:]
	}
	if len(args) == 0 {
		return fishQueryHelp
	}
	// The contact queries the whole species, without a trophy-grade filter.
	req := FishQueryRequest{UID: sess.Userid, Map: s.currentLevel(sess.Userid), Grade: 1}
	var err error
	req.Fish, req.Map, err = s.resolveFishQueryArgs(ctx, args, req.Map)
	if err != nil {
		return err.Error()
	}
	if s.tunableF("fish_weight_cap", 0) > 0 || s.tunableF("hook_entry_cap", 0) > 0 {
		st := s.stateFor(req.UID)
		st.mu.Lock()
		req.Gear = st.GearGuid
		st.mu.Unlock()
	}
	result, err := s.QueryFish(ctx, req)
	if err != nil {
		if errors.Is(err, errFishQueryRegionMapUnsupported) {
			return err.Error()
		}
		if errors.Is(err, errFishQueryWaterInvalid) {
			s.log.Warn("Неверные данные вода/суша для поиска рыбы", "err", err)
			return errFishQueryWaterInvalid.Error()
		}
		s.log.Warn("Поиск рыбы не удался", "uid", req.UID, "err", err)
		if ctx.Err() != nil {
			return fishQueryTimeoutReply
		}
		if req.Gear == "" && (s.tunableF("fish_weight_cap", 0) > 0 || s.tunableF("hook_entry_cap", 0) > 0) {
			return "Ограничение нагрузки снастей включено — сначала возьмите в руки удилище, которым будете ловить."
		}
		return "Сейчас запрос выполнить нельзя, проверьте карту и вид рыбы и повторите."
	}
	return formatFishQueryReply(s.speciesZhName(ctx, req.Fish), result)
}

func formatFishQueryReply(fishName string, result *FishQueryResponse) string {
	fishName = fishQueryName(fishName)
	if len(result.Plans) == 0 {
		return fishName + "\nНа текущей карте при текущих условиях подходящих вариантов нет, можно указать другую карту."
	}
	lines := []string{names.Ru(result.Plans[0].MapName) + " · " + fishName}
	reference := ""
	uniform := false
	missingFamily := false
	for _, family := range fishQueryFamilyRenderOrder {
		plans := make([]FishQueryPlan, 0, fishQueryPlansPerFamily)
		for _, plan := range result.Plans {
			if fishQueryFamilyForRig(plan.RigType) == family {
				plans = append(plans, plan)
			}
		}
		if len(plans) == 0 {
			if family != fishQueryFamilyOther {
				missingFamily = true
			}
			continue
		}
		if len(plans) > fishQueryPlansPerFamily {
			plans = plans[:fishQueryPlansPerFamily]
		}
		lines = append(lines, "["+family.label()+"]")
		for i, plan := range plans {
			method := fishQueryMethodLabel(plan)
			if plan.Action == "drift" {
				method += " · сплав по течению"
			} else if plan.Action == "jig" {
				method += " · ступенька"
			}
			bait := names.Ru(plan.BaitName)
			if plan.EquivalentBaits > 1 {
				bait = fmt.Sprintf("%s (равноценных наживок: %d)", bait, plan.EquivalentBaits)
			}
			lines = append(lines, fmt.Sprintf("%d. %s · %s · теор. %.2f рыб/час", i+1, bait, method, plan.TheoreticalPerHour))
			if plan.Region != nil {
				lines = append(lines, "   "+formatFishQueryRegion(*plan.Region))
			} else if plan.X != nil && plan.Z != nil {
				point := fmt.Sprintf("   Точка в мире X %.1f / Z %.1f", *plan.X, *plan.Z)
				if sonarChartLevel(plan.Map) {
					if spot := seaGuideSpotForPoint(*plan.X, *plan.Z); spot > 0 {
						point += fmt.Sprintf(" (точка %d м)", spot)
					}
				}
				if plan.Zone > 0 {
					point += fmt.Sprintf(" (зона эхолота %d)", plan.Zone)
				}
				lines = append(lines, point)
			} else if reference == "" && len(plan.References) > 0 {
				reference = plan.References[0].Coordinate
			}
			uniform = uniform || plan.CoordinateKind == "region_uniform"
		}
	}
	if reference != "" {
		lines = append(lines, "Ориентир из гайдов: "+reference+" (не участвует в расчёте вероятности)")
	}
	if uniform {
		lines = append(lines, "Распределение стай выключено, зоны не рекомендуются.")
	}
	if missingFamily {
		lines = append(lines, "Показаны только способы ловли, для которых при текущих условиях есть варианты.")
	}
	lines = append(lines, "Теоретическая скорость не учитывает время вываживания и вытаскивания.")
	return strings.Join(lines, "\n")
}

func formatFishQueryRegion(r FishQueryRegion) string {
	var labels [4]string
	approx := " "
	for i, value := range [4]float64{r.MinX, r.MinZ, r.MaxX, r.MaxZ} {
		rounded := math.Round(value*100) / 100
		if math.Abs(rounded-value) > 1e-9 {
			approx = " около "
		}
		labels[i] = strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", rounded), "0"), ".")
	}
	return fmt.Sprintf("Зона%s%s:%s–%s:%s (верхняя граница не включена)", approx, labels[0], labels[1], labels[2], labels[3])
}

func fishQueryMethodLabel(plan FishQueryPlan) string {
	switch plan.RigType {
	case 1:
		return "Поплавок"
	case 12:
		return "Донка"
	case 5:
		return "Спиннинг"
	case 50:
		return "Морской пилкер"
	case 51:
		return "Морская мягкая приманка"
	case 52:
		return "Морская ловля на рыбу"
	case 55:
		return "Морская донная ловля"
	}
	return plan.RigName
}

func (s *Server) receiveFishQuery(ctx *Ctx, text string) ([]byte, bool) {
	if !ctx.ExpectResponse {
		return nil, true
	}
	queryCtx, cancel := context.WithTimeout(ctx.Sess.pushCtx(), fishQueryBudget)
	defer cancel()
	text = strings.TrimSpace(text)
	reply := fishQueryHelp
	if len([]rune(text)) <= 100 {
		reply = s.fishQueryReply(queryCtx, ctx.Sess, text)
	}
	c := ctx.Sess.pushCtx()
	tx, err := beginEconomyTx(c, s.DB)
	if err != nil {
		ctx.ReplyFailure("System.IO.IOException", "Не удалось сохранить ответ на запрос")
		return nil, true
	}
	defer func() { _ = tx.Rollback() }()
	id, err := insertContactReply(c, tx, ctx.Sess.Userid, fishQueryContactUID, reply)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		ctx.ReplyFailure("System.IO.IOException", "Не удалось сохранить ответ на запрос")
		return nil, true
	}
	ctx.AfterResponse(func() { s.notifyMail(ctx.Sess.pushCtx(), ctx.Sess.Userid, id) })
	return []byte{0}, true
}
