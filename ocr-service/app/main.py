from functools import lru_cache
import json
import time

import cv2
import fitz
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI()
MAX_BYTES = 20 * 1024 * 1024


def log_event(level: str, event: str, message: str, **fields: str | int | float) -> None:
    """Write stable, non-sensitive JSON records for the container log collector."""
    print(json.dumps({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "service": "ocr",
        "event": event,
        "message": message,
        **fields,
    }), flush=True)

@app.get("/health")
def health():
    return {"status": "ok"}


@lru_cache
def get_ocr():
    from paddleocr import PaddleOCR

    return PaddleOCR(lang="ch")


def decode_pages(content: bytes, content_type: str) -> list[np.ndarray]:
    if content_type != "application/pdf":
        image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise HTTPException(status_code=422, detail="invalid image")
        return [image]

    try:
        document = fitz.open(stream=content, filetype="pdf")
        pages = []
        for page in document:
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
            pages.append(cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
        document.close()
        if not pages:
            raise HTTPException(status_code=422, detail="empty pdf")
        return pages
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="invalid pdf") from error


@app.post("/extract")
async def extract(file: UploadFile = File(...)):
    started_at = time.monotonic()
    try:
        if file.content_type not in {"image/jpeg", "image/png", "application/pdf"}:
            raise HTTPException(status_code=415, detail="unsupported media type")
        content = await file.read()
        if len(content) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="file too large")
        ocr = get_ocr()
        pages = []
        for image in decode_pages(content, file.content_type):
            result = ocr.predict(image)
            for page in result:
                texts = [str(text) for text in page.get("rec_texts", [])]
                scores = [float(score) for score in page.get("rec_scores", [])]
                pages.append({
                    "text": "\n".join(texts),
                    "confidence": sum(scores) / len(scores) if scores else 0,
                })
        log_event("info", "ocr.extract.completed", "票据 OCR 识别完成", status=200, durationMs=round((time.monotonic() - started_at) * 1000))
        return {"modelVersion": "paddleocr-3.7.0", "pages": pages}
    except HTTPException as error:
        log_event("warn", "ocr.extract.rejected", "票据 OCR 请求被拒绝", status=error.status_code, durationMs=round((time.monotonic() - started_at) * 1000))
        raise
    except Exception as error:
        log_event("error", "ocr.extract.failed", "票据 OCR 识别失败", status=500, failureCode="ocr_extract_failed", durationMs=round((time.monotonic() - started_at) * 1000))
        raise HTTPException(status_code=500, detail="ocr processing failed") from error
