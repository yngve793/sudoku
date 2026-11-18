"""Outgoing email: the `EmailSender` interface and its implementations."""

from __future__ import annotations

import logging
import smtplib
import threading
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

from sudoku_api.config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OutgoingEmail:
    to: str
    subject: str
    text: str
    html: str


class EmailSender(Protocol):
    def send(self, message: OutgoingEmail) -> None: ...


class ConsoleEmailSender:
    """Logs messages and keeps them in memory (tests read tokens from `outbox`)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.outbox: list[OutgoingEmail] = []

    def send(self, message: OutgoingEmail) -> None:
        with self._lock:
            self.outbox.append(message)
        logger.info(
            "email (console) to=%s subject=%s\n%s", message.to, message.subject, message.text
        )


class SmtpEmailSender:
    """Sends via SMTP with the standard library (Mailpit in dev, real SMTP in prod)."""

    def __init__(self, settings: Settings) -> None:
        self._host = settings.smtp_host
        self._port = settings.smtp_port
        self._username = settings.smtp_username
        self._password = settings.smtp_password
        self._starttls = settings.smtp_starttls
        self._timeout = settings.smtp_timeout_seconds
        self._from = settings.email_from

    def build(self, message: OutgoingEmail) -> EmailMessage:
        msg = EmailMessage()
        msg["From"] = self._from
        msg["To"] = message.to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        msg.add_alternative(message.html, subtype="html")
        return msg

    def send(self, message: OutgoingEmail) -> None:
        msg = self.build(message)
        with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
            if self._starttls:
                smtp.starttls()
            if self._username:
                smtp.login(self._username, self._password)
            smtp.send_message(msg)


def make_email_sender(settings: Settings) -> EmailSender:
    if settings.email_backend == "smtp":
        return SmtpEmailSender(settings)
    return ConsoleEmailSender()


def send_safely(sender: EmailSender, message: OutgoingEmail) -> None:
    """Background-task entry point: never let a mail failure crash the worker."""
    try:
        sender.send(message)
    except Exception:
        logger.exception("failed to send email subject=%s", message.subject)
