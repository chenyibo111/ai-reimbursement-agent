FROM python:3.11-slim

ARG TORCH_VARIANT=default

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_CACHE_DIR=/models

COPY requirements.txt ./
RUN if [ "$TORCH_VARIANT" = "cpu" ]; then pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.6.0+cpu; fi \
    && pip install --no-cache-dir -r requirements.txt
COPY app.py ./

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
