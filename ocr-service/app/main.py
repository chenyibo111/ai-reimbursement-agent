from functools import lru_cache

import cv2
import fitz
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI()
MAX_BYTES = 20 * 1024 * 1024

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
    return {"modelVersion": "paddleocr-3.7.0", "pages": pages}
