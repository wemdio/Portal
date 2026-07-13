# Официальный образ Playwright — содержит Chromium нужной версии + все
# системные библиотеки (libnss3, libatk*, libgbm, libasound2 и т.д.),
# которые иначе пришлось бы вручную ставить через apt. Обновлять тег
# при апгрейде playwright в requirements.txt — версии должны совпадать.
FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY server.py /app/server.py
COPY yandex_parser.py /app/yandex_parser.py

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
