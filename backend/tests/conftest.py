"""Fail safely and quickly if an explicitly configured test database is offline."""
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError


def pytest_sessionstart(session):
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        return
    engine = None
    try:
        engine = create_engine(url, connect_args={'connect_timeout': 3}, hide_parameters=True)
        with engine.connect() as connection:
            connection.execute(text('SELECT 1'))
    except (SQLAlchemyError, ValueError):
        pytest.exit('PostgreSQL kiểm thử chưa sẵn sàng. Khởi động database và kiểm tra cấu hình; thông tin kết nối đã được ẩn.', returncode=2)
    finally:
        if engine is not None:
            engine.dispose()
