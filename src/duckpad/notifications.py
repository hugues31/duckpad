"""Instance notification destinations and their delivery.

Instance administrators configure the SMTP server and named destinations: email recipients or
an outgoing webhook URL. The SMTP password and webhook URLs are credentials, sealed in instance
settings and never returned. Scenarios reference destinations by identifier.
"""

import re
import smtplib
import ssl
from email.message import EmailMessage
from typing import Literal
from urllib.parse import urlsplit

import httpx2
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .types import Record
from .util import Problem, now, uid

SETTINGS = "notifications"
TIMEOUT = 10
EMAIL = re.compile(r"[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+")
DEFAULT_SMTP = {"host": "", "port": 587, "security": "starttls", "username": "", "sender": ""}


class SMTPSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    host: str = Field(default="", max_length=255)
    port: int = Field(default=587, ge=1, le=65535)
    security: Literal["starttls", "tls", "none"] = "starttls"
    username: str = Field(default="", max_length=255)
    # Omitted or blank keeps the saved password; it is never returned.
    password: SecretStr | None = None
    clear_password: bool = False
    sender: str = Field(default="", max_length=255)


class Destination(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str | None = Field(default=None, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["email", "webhook"]
    recipients: list[str] = Field(default_factory=list, max_length=20)
    # Omitted or blank keeps the saved URL of the same destination; it is never returned.
    url: SecretStr | None = None


class NotificationSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    smtp: SMTPSettings = Field(default_factory=SMTPSettings)
    destinations: list[Destination] = Field(default_factory=list, max_length=50)


def host(url: str) -> str:
    return urlsplit(url).netloc


class Notifications:
    def __init__(self, store):
        self.store = store

    def stored(self) -> Record:
        value = self.store.get("settings", SETTINGS) or {}
        return {
            "smtp": {**DEFAULT_SMTP, **value.get("smtp", {})},
            "destinations": value.get("destinations", []),
        }

    def public(self) -> Record:
        """Settings without credentials, for instance administrators."""
        config = self.stored()
        smtp = {key: value for key, value in config["smtp"].items() if key != "password"}
        return {
            "smtp": {**smtp, "has_password": bool(config["smtp"].get("password"))},
            "destinations": [self.describe(item) for item in config["destinations"]],
        }

    @staticmethod
    def describe(destination: Record) -> Record:
        result = {key: destination[key] for key in ("id", "name", "kind")}
        if destination["kind"] == "email":
            result["recipients"] = destination["recipients"]
        else:
            result["url_host"] = host(destination["url"])
        return result

    def destinations(self) -> list[Record]:
        """Names a project administrator can choose from; no recipient or URL."""
        return [{key: item[key] for key in ("id", "name", "kind")} for item in self.stored()["destinations"]]

    def destination(self, identity: str) -> Record | None:
        return next((item for item in self.stored()["destinations"] if item["id"] == identity), None)

    def save(self, data: NotificationSettings) -> Record:
        previous = self.stored()
        smtp = data.smtp.model_dump(exclude={"password", "clear_password"})
        password = data.smtp.password.get_secret_value() if data.smtp.password else ""
        if len(password) > 4096:
            raise Problem("The SMTP password is too long", 422)
        if not data.smtp.clear_password:
            password = password or previous["smtp"].get("password", "")
        if password:
            smtp["password"] = password
        if smtp["sender"] and not EMAIL.fullmatch(smtp["sender"]):
            raise Problem("Enter the sender as an email address", 422)
        known = {item["id"]: item for item in previous["destinations"]}
        destinations, names = [], set()
        for item in data.destinations:
            if item.name.casefold() in names:
                raise Problem(f"Two destinations are named {item.name}", 422)
            names.add(item.name.casefold())
            identity = item.id if item.id in known else uid("dst_")
            entry: Record = {"id": identity, "name": item.name, "kind": item.kind}
            if item.kind == "email":
                recipients = [address.strip() for address in item.recipients if address.strip()]
                if not recipients:
                    raise Problem(f"Add at least one recipient to {item.name}", 422)
                for address in recipients:
                    if not EMAIL.fullmatch(address):
                        raise Problem(f"{address} is not an email address", 422)
                entry["recipients"] = recipients
            else:
                url = item.url.get_secret_value().strip() if item.url else ""
                saved = known.get(identity, {})
                url = url or (saved.get("url", "") if saved.get("kind") == "webhook" else "")
                parts = urlsplit(url)
                if parts.scheme not in ("http", "https") or not parts.netloc or len(url) > 2048:
                    raise Problem(f"Enter the HTTPS or HTTP URL of {item.name}", 422)
                entry["url"] = url
            destinations.append(entry)
        if any(item["kind"] == "email" for item in destinations) and not (smtp["host"] and smtp["sender"]):
            raise Problem("Configure the SMTP server and sender before adding email destinations", 422)
        self.store.put("settings", SETTINGS, {"smtp": smtp, "destinations": destinations})
        return self.public()

    def deliver(self, destination: Record, message: Record) -> None:
        """Send one message; raise Problem with a readable reason on failure."""
        if destination["kind"] == "webhook":
            try:
                with httpx2.Client(timeout=TIMEOUT, follow_redirects=False) as client:
                    response = client.post(destination["url"], json=message["payload"])
            except httpx2.HTTPError as error:
                raise Problem(f"Webhook delivery failed: {type(error).__name__}", 502) from error
            if response.status_code >= 300:
                raise Problem(f"Webhook delivery failed: HTTP {response.status_code}", 502)
            return
        smtp = self.stored()["smtp"]
        if not smtp["host"] or not smtp["sender"]:
            raise Problem("The SMTP server is not configured", 502)
        email = EmailMessage()
        email["Subject"] = message["subject"]
        email["From"] = smtp["sender"]
        email["To"] = ", ".join(destination["recipients"])
        email.set_content(message["text"])
        context = ssl.create_default_context()
        try:
            if smtp["security"] == "tls":
                client = smtplib.SMTP_SSL(smtp["host"], smtp["port"], timeout=TIMEOUT, context=context)
            else:
                client = smtplib.SMTP(smtp["host"], smtp["port"], timeout=TIMEOUT)
            with client:
                if smtp["security"] == "starttls":
                    client.starttls(context=context)
                if smtp["username"]:
                    client.login(smtp["username"], smtp.get("password", ""))
                client.send_message(email)
        except (OSError, smtplib.SMTPException) as error:
            raise Problem(f"Email delivery failed: {error}", 502) from error

    def send(self, identity: str, message: Record) -> Record:
        """Deliver to a destination and return the delivery record; never raise."""
        destination = self.destination(identity)
        record: Record = {"destination": identity, "at": now()}
        if destination is None:
            return {**record, "name": identity, "status": "failed", "error": "The destination was deleted"}
        record["name"] = destination["name"]
        try:
            self.deliver(destination, message)
        except Problem as error:
            return {**record, "status": "failed", "error": str(error)[:500]}
        return {**record, "status": "sent"}

    def test(self, identity: str) -> Record:
        text = "This test message confirms that Duckpad can reach this destination."
        result = self.send(
            identity,
            {
                "subject": "Duckpad test notification",
                "text": text,
                "payload": {"event": "test", "text": text},
            },
        )
        if result["status"] != "sent":
            raise Problem(result["error"], 502)
        return result
