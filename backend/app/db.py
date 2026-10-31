import os
from functools import lru_cache
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

load_dotenv(Path(__file__).resolve().parents[2] / '.env')

@lru_cache
def get_engine():
    url = os.environ.get('DATABASE_URL', '')
    if not url:
        raise RuntimeError('DATABASE_URL chưa được cấu hình')
    parsed = make_url(url)
    if parsed.drivername != 'postgresql+psycopg':
        raise RuntimeError('Chỉ hỗ trợ PostgreSQL qua psycopg')
    return create_engine(url, pool_pre_ping=True, hide_parameters=True, connect_args={'connect_timeout': 3})

def get_db():
    with sessionmaker(bind=get_engine(), expire_on_commit=False)() as db:
        yield db
