#!/usr/bin/env python3
"""Генерирует internal/admin/web/app/names-ru.js из internal/names/names_ru.json.

Словарь «китайское название → русское» для рыб, водоёмов и наживок ведётся
в одном месте (names_ru.json); сервер встраивает его через go:embed, а
админ-панели нужна копия в виде ES-модуля. Запуск из корня репозитория:

    python3 tools/gen_names_ru.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "internal/names/names_ru.json"
DST = ROOT / "internal/admin/web/app/names-ru.js"

TEMPLATE = """// Сгенерировано tools/gen_names_ru.py из internal/names/names_ru.json — не редактировать вручную.
// Русские названия рыб, водоёмов и наживок. В данных они остаются китайскими
// (это ключи правил), переводятся только при показе.
export const NAMES_RU = %s;
const KEYS = Object.keys(NAMES_RU).sort((a, b) => b.length - a.length);
const HAN = /[\\u4e00-\\u9fff]/;
let re = null;
export function ru(s) {
  if (typeof s !== 'string' || !HAN.test(s)) return s;
  const t = s.replace(/\\ufeff/g, '').trim();
  if (Object.prototype.hasOwnProperty.call(NAMES_RU, t)) return NAMES_RU[t];
  re = re || new RegExp(KEYS.map((k) => k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|'), 'g');
  const out = s.replace(re, (m) => NAMES_RU[m]);
  // Перевод только целиком: смесь языков читается хуже исходника.
  return HAN.test(out) ? s : out;
}
"""


def main():
    names = json.loads(SRC.read_text(encoding="utf-8"))
    body = json.dumps(names, ensure_ascii=False, indent=1, sort_keys=True)
    DST.write_text(TEMPLATE % body, encoding="utf-8")
    print(f"{DST.relative_to(ROOT)}: {len(names)} названий")


if __name__ == "__main__":
    main()
