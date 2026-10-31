"""Best-effort expiry monitor. A failed pass does not prevent the API starting."""
import asyncio
import logging
from contextlib import suppress

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .captures import reconcile_expired
from .db import get_engine

logger = logging.getLogger(__name__)


def reconcile_once():
    try:
        with Session(bind=get_engine()) as db:
            reconcile_expired(db)
            db.commit()
    except (SQLAlchemyError, RuntimeError, OSError):
        # Do not log patient data, DB URLs, or sensitive exception details.
        logger.warning('Capture lease reconciliation unavailable; will retry')


async def monitor():
    while True:
        await asyncio.to_thread(reconcile_once)
        await asyncio.sleep(30)


async def stop_monitor(task):
    if task is not None:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
