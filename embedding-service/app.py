import math
import os
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
from sentence_transformers import SentenceTransformer

MAX_BATCH_SIZE = 32
MAX_TEXT_LENGTH = 12_000
DIMENSIONS = 1024

app = FastAPI(title="private-embedding-service", docs_url=None, redoc_url=None)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_BATCH_SIZE)
    model: str | None = None

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        if any(not text.strip() or len(text) > MAX_TEXT_LENGTH for text in texts):
            raise ValueError("texts must be nonempty and bounded")
        return texts


@lru_cache(maxsize=1)
def embedding_model() -> SentenceTransformer:
    return SentenceTransformer(
        os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3"),
        cache_folder=os.getenv("MODEL_CACHE_DIR", "/models"),
        device=os.getenv("EMBEDDING_DEVICE", "cpu"),
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed")
def embed(request: EmbedRequest) -> dict[str, list[list[float]]]:
    vectors = embedding_model().encode(request.texts, normalize_embeddings=True).tolist()
    if any(len(vector) != DIMENSIONS or any(not math.isfinite(value) for value in vector) for vector in vectors):
        raise HTTPException(status_code=502, detail="embedding output is invalid")
    return {"vectors": vectors}
