import sys
import types
import unittest
from unittest.mock import patch

import fitz
import cv2
from fastapi import HTTPException
from fastapi.testclient import TestClient
import numpy as np

from app.main import app, decode_pages, get_ocr


class ExtractRouteTest(unittest.TestCase):
    def setUp(self):
        get_ocr.cache_clear()

    def test_pdf_info_accepts_compressed_page_objects_and_rejects_invalid_pdf(self):
        document = fitz.open()
        document.new_page()
        content = document.tobytes(garbage=4, deflate=True, use_objstms=1)
        document.close()
        self.assertNotIn(b"/Type /Page ", content)
        response = TestClient(app).post("/pdf-info", files={"file": ("invoice.pdf", content, "application/pdf")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"pages": 1})
        invalid = TestClient(app).post("/pdf-info", files={"file": ("invoice.pdf", b"%PDF-broken", "application/pdf")})
        self.assertEqual(invalid.status_code, 422)

    def test_pdf_page_limit_is_checked_before_rendering(self):
        document = fitz.open()
        for _ in range(21):
            document.new_page()
        content = document.tobytes()
        document.close()
        with self.assertRaises(HTTPException) as raised:
            decode_pages(content, "application/pdf")
        self.assertEqual(raised.exception.status_code, 422)

    def test_decodes_an_uploaded_image_before_calling_paddleocr(self):
        fake_paddleocr = types.ModuleType("paddleocr")
        captured = []
        instances = []

        class FakePaddleOCR:
            def __init__(self, **_kwargs):
                instances.append(self)

            def predict(self, content):
                captured.append(content)
                return []

        fake_paddleocr.PaddleOCR = FakePaddleOCR
        encoded_ok, image_content = cv2.imencode(".png", np.full((32, 32, 3), 255, dtype=np.uint8))
        self.assertTrue(encoded_ok)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
            response = TestClient(app).post(
                "/extract",
                files={"file": ("receipt.png", image_content.tobytes(), "image/png")},
            )
            second_response = TestClient(app).post(
                "/extract",
                files={"file": ("receipt.png", image_content.tobytes(), "image/png")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(response.json()["modelVersion"], "paddleocr-3.7.0")
        self.assertEqual(len(captured), 2)
        self.assertTrue(all(isinstance(content, np.ndarray) for content in captured))
        self.assertEqual(len(instances), 1)

    def test_renders_each_pdf_page_before_calling_paddleocr(self):
        fake_paddleocr = types.ModuleType("paddleocr")
        captured = []

        class FakePaddleOCR:
            def __init__(self, **_kwargs):
                pass

            def predict(self, content):
                captured.append(content)
                return []

        fake_paddleocr.PaddleOCR = FakePaddleOCR
        document = fitz.open()
        document.new_page()
        content = document.tobytes()
        document.close()

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
            response = TestClient(app).post(
                "/extract",
                files={"file": ("receipt.pdf", content, "application/pdf")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(captured), 1)
        self.assertIsInstance(captured[0], np.ndarray)

    def test_returns_recognized_text_and_average_confidence(self):
        fake_paddleocr = types.ModuleType("paddleocr")

        class FakePaddleOCR:
            def __init__(self, **_kwargs):
                pass

            def predict(self, _content):
                return [{"rec_texts": ["发票号码：12345678", "价税合计（小写）￥386.00"], "rec_scores": [0.8, 1.0]}]

        fake_paddleocr.PaddleOCR = FakePaddleOCR
        encoded_ok, image_content = cv2.imencode(".png", np.full((32, 32, 3), 255, dtype=np.uint8))
        self.assertTrue(encoded_ok)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
            response = TestClient(app).post(
                "/extract",
                files={"file": ("receipt.png", image_content.tobytes(), "image/png")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["pages"],
            [{"text": "发票号码：12345678\n价税合计（小写）￥386.00", "confidence": 0.9}],
        )

    def test_rejects_an_invalid_image(self):
        response = TestClient(app).post(
            "/extract",
            files={"file": ("receipt.png", b"not-a-png", "image/png")},
        )

        self.assertEqual(response.status_code, 422)
