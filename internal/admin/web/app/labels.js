// 后端动作代码 → 管理员看得懂的中文。
export const AUDIT_LABELS = {
  login: 'Вход в админку', tunable: 'Изменение значений', player_update: 'Изменение персонажа', grant_item: 'Выдача предмета', item_delete: 'Удаление предмета',
  keepnet_add: 'В садок', keepnet_delete: 'Из садка', mail_send: 'Отправка письма', mail_delete: 'Удаление письма',
  skill_points: 'Изменение очков навыков', skill_proficiency: 'Изменение мастерства навыков', kick: 'Отключение игрока', ban: 'Бан',
  shop_override: 'Изменение товара', shop_override_reset: 'Сброс товара', fish_config: 'Изменение рыб водоёма', fish_config_reset: 'Сброс водоёма',
  fish_zone_save: 'Сохранение зоны рыбы', fish_zone_delete: 'Удаление зоны рыбы', bite_mode: 'Смена стиля игры', spawn_mode: 'Смена режима выдачи рыбы',
  hook_profile: 'Настройка крючков', bait_rule_save: 'Изменение предпочтений наживки', bait_rule_reset: 'Сброс предпочтений наживки', skill_gain_mode: 'Смена вероятности прокачки навыков',
};
export const auditLabel = (a) => AUDIT_LABELS[a] || a || '—';
