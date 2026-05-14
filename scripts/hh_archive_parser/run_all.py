"""
run_all.py — запускает полный пайплайн: парсинг → фильтрация.

Запуск:
    python run_all.py
"""

import sys
import scraper
import filter as pr_filter
from config import RAW_CSV

def main():
    print("=" * 55)
    print("  ШАГ 1: Парсинг вакансий с hh.ru")
    print("=" * 55)
    scraper.run()

    print()
    print("=" * 55)
    print("  ШАГ 2: Фильтрация — оставляем только PR")
    print("=" * 55)
    pr_filter.run(RAW_CSV)

    print()
    print("Готово. Файлы в папке output/")


if __name__ == "__main__":
    main()
