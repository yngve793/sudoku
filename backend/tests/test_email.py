from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from sudoku_api.services.email import (
    ConsoleEmailSender,
    OutgoingEmail,
    SmtpEmailSender,
    make_email_sender,
    send_safely,
)
from sudoku_api.services.email_templates import reset_password_email, verification_email

from tests.conftest import make_settings

MSG = OutgoingEmail(to="a@example.com", subject="Hi", text="plain", html="<p>html</p>")


def test_factory() -> None:
    assert isinstance(make_email_sender(make_settings(email_backend="console")), ConsoleEmailSender)
    assert isinstance(make_email_sender(make_settings(email_backend="smtp")), SmtpEmailSender)


def test_smtp_sender_builds_multipart_and_sends() -> None:
    settings = make_settings(
        email_backend="smtp",
        smtp_host="mail.local",
        smtp_port=2525,
        smtp_username="user",
        smtp_password="pw",
        smtp_starttls=True,
    )
    sender = SmtpEmailSender(settings)
    with patch("sudoku_api.services.email.smtplib.SMTP") as smtp_cls:
        smtp: Any = MagicMock()
        smtp_cls.return_value.__enter__.return_value = smtp
        sender.send(MSG)
    smtp_cls.assert_called_once_with("mail.local", 2525, timeout=settings.smtp_timeout_seconds)
    smtp.starttls.assert_called_once()
    smtp.login.assert_called_once_with("user", "pw")
    sent = smtp.send_message.call_args.args[0]
    assert sent["To"] == "a@example.com"
    assert sent.is_multipart()
    assert {p.get_content_type() for p in sent.iter_parts()} == {"text/plain", "text/html"}


def test_send_safely_swallows_errors() -> None:
    failing = MagicMock()
    failing.send.side_effect = OSError("down")
    send_safely(failing, MSG)  # does not raise


def test_templates_escape_and_link() -> None:
    v = verification_email("a@example.com", "<b>x</b>", "tok", "http://f/", 24)
    assert "http://f/verify-email?token=tok" in v.text
    assert "<b>x</b>" not in v.html
    assert "&lt;b&gt;" in v.html
    r = reset_password_email("a@example.com", "u", "tok", "http://f", 60)
    assert "http://f/reset-password?token=tok" in r.text
    assert "60 minutes" in r.text
