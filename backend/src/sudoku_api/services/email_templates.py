"""Plain-text + HTML templates for transactional emails."""

from __future__ import annotations

from html import escape
from urllib.parse import urlencode

from sudoku_api.services.email import OutgoingEmail


def _link(frontend_url: str, path: str, token: str) -> str:
    return f"{frontend_url.rstrip('/')}{path}?{urlencode({'token': token})}"


def _html(title: str, intro: str, link: str, button: str, footer: str) -> str:
    return (
        '<!doctype html><html><body style="font-family:sans-serif">'
        f"<h1>{escape(title)}</h1><p>{escape(intro)}</p>"
        f'<p><a href="{escape(link, quote=True)}">{escape(button)}</a></p>'
        f'<p style="color:#666">{escape(footer)}</p></body></html>'
    )


def verification_email(
    to: str, username: str, token: str, frontend_url: str, ttl_hours: int
) -> OutgoingEmail:
    link = _link(frontend_url, "/verify-email", token)
    intro = f"Hi {username}, please confirm your email address to start playing Sudoku."
    footer = (
        f"This link expires in {ttl_hours} hours and works once. "
        "If you did not create an account, you can ignore this email."
    )
    text = f"{intro}\n\n{link}\n\n{footer}\n"
    return OutgoingEmail(
        to=to,
        subject="Verify your email address",
        text=text,
        html=_html("Verify your email", intro, link, "Verify email", footer),
    )


def reset_password_email(
    to: str, username: str, token: str, frontend_url: str, ttl_minutes: int
) -> OutgoingEmail:
    link = _link(frontend_url, "/reset-password", token)
    intro = f"Hi {username}, someone asked to reset the password for your Sudoku account."
    footer = (
        f"This link expires in {ttl_minutes} minutes and works once. "
        "If this wasn't you, ignore this email; your password stays unchanged."
    )
    text = f"{intro}\n\n{link}\n\n{footer}\n"
    return OutgoingEmail(
        to=to,
        subject="Reset your password",
        text=text,
        html=_html("Reset your password", intro, link, "Choose a new password", footer),
    )


def account_exists_email(to: str, username: str, frontend_url: str) -> OutgoingEmail:
    """Sent when someone tries to register with an address that already has an account."""
    link = f"{frontend_url.rstrip('/')}/forgot-password"
    intro = (
        f"Hi {username}, someone tried to create a new Sudoku account with this email address. "
        "You already have an account, so nothing was changed."
    )
    footer = (
        "If this was you, just log in. If you forgot your password, you can reset it. "
        "If it wasn't you, you can ignore this email."
    )
    text = f"{intro}\n\nReset your password: {link}\n\n{footer}\n"
    return OutgoingEmail(
        to=to,
        subject="You already have a Sudoku account",
        text=text,
        html=_html("You already have an account", intro, link, "Reset password", footer),
    )
