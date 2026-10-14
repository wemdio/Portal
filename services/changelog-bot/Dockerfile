FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY main.py /app/main.py
COPY ve2_digest.py ve2_snapshot.sql ve2_baseline.json /app/

EXPOSE 8095

CMD ["python", "-u", "main.py"]
