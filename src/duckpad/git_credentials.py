"""Per-account SSH keys, trusted Git hosts and URL-bound consent for network Git.

Network Git never uses credentials of the server account. SSH origins use the key
that Duckpad generated for the account that triggers the operation, only on hosts
that an instance administrator trusts and only for the origin URL that this account
confirmed in this project. HTTPS origins run without credentials.
"""

import base64
import binascii
import hashlib
import re
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from .util import Problem, now, uid

KEY_KIND = "ssh_key"
CONSENT_KIND = "git_consent"
HOSTS_SETTING = "git_hosts"
SCP_URL = re.compile(r"(?P<user>[A-Za-z0-9_.-]+)@(?P<host>[A-Za-z0-9.-]+):(?P<path>[A-Za-z0-9_./~-]+)")
HOST_KEY_TYPES = (
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
)
HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*")
MAX_HOST_KEYS = 200
MAX_PREFIXES = 100
ORIGIN_REFUSED = (
    "This origin is not allowed on this instance. Ask an instance administrator to trust its SSH host "
    "or to allow its URL prefix in the Git hosts settings."
)


def fingerprint(public_key):
    """OpenSSH SHA256 fingerprint of an OpenSSH public key line."""
    blob = base64.b64decode(public_key.split()[1])
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def generate_key(comment):
    private = ed25519.Ed25519PrivateKey.generate()
    private_text = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()
    ).decode()
    public_text = (
        private.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )
    return private_text, f"{public_text} {comment}"


def endpoint(url):
    """Return (transport, host, port, path) of a URL accepted by remote.validate_url."""
    scp = SCP_URL.fullmatch(url)
    if scp:
        return "ssh", scp["host"].lower(), 22, scp["path"]
    parts = urlsplit(url)
    port = parts.port or (22 if parts.scheme == "ssh" else 443)
    return parts.scheme, (parts.hostname or "").lower(), port, parts.path


def transport(url):
    return endpoint(url)[0] if url else None


def host_token(host, port):
    return host if port == 22 else f"[{host}]:{port}"


def parse_host(token):
    match = re.fullmatch(r"\[([^\]]+)\]:(\d{1,5})", token)
    host, port = (match[1], int(match[2])) if match else (token, 22)
    host = host.lower()
    if not HOSTNAME.fullmatch(host) or not 1 <= port <= 65535:
        raise Problem(f"Use host names or [host]:port without wildcards in trusted host keys: {token[:80]}")
    return host_token(host, port)


def parse_known_hosts(text):
    """Validate known_hosts lines and return normalized entries."""
    if not isinstance(text, str) or len(text) > 256 * 1024:
        raise Problem("Provide trusted host keys as known_hosts text")
    entries = []
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if fields[0].startswith("@") or fields[0].startswith("|"):
            raise Problem(f"Line {number}: markers and hashed host names are not supported")
        if len(fields) < 3:
            raise Problem(f"Line {number}: use the format 'host key-type base64-key'")
        hosts, kind, key = fields[0], fields[1], fields[2]
        if kind not in HOST_KEY_TYPES:
            raise Problem(f"Line {number}: unsupported host key type {kind[:40]}")
        try:
            serialization.load_ssh_public_key(f"{kind} {key}".encode())
        except (ValueError, binascii.Error, TypeError) as error:
            raise Problem(f"Line {number}: invalid {kind} host key") from error
        tokens = list(dict.fromkeys(parse_host(token) for token in hosts.split(",") if token))
        if not tokens:
            raise Problem(f"Line {number}: name at least one host")
        entries.append({"hosts": tokens, "type": kind, "key": key})
    if len(entries) > MAX_HOST_KEYS:
        raise Problem(f"Trust at most {MAX_HOST_KEYS} host keys")
    return entries


def validate_prefix(prefix):
    # Imported here because remote.py depends on this module.
    from .remote import validate_url

    message = (
        "Use URL prefixes such as https://git.example.com/team/ or git@git.example.com:team/ that end "
        "with / or :"
    )
    if not isinstance(prefix, str) or not prefix.endswith(("/", ":")):
        raise Problem(message)
    try:
        validate_url(prefix + "repository")
    except Problem as error:
        raise Problem(message) from error
    # A scheme URL prefix must contain its complete host, so "https://host" + "x" cannot match.
    if "://" in prefix and "/" not in prefix.split("://", 1)[1]:
        raise Problem(message)
    return prefix


class GitCredentials:
    def __init__(self, store):
        self.store = store

    # Account keys

    def public_key(self, user_id):
        record = self.store.get(KEY_KIND, user_id)
        if not record:
            return None
        return {key: record[key] for key in ("public_key", "fingerprint", "created")}

    def generate_key(self, user):
        with self.store.lock:
            current = self.store.get("user", user["id"])
            if not current or not current["active"]:
                raise Problem("Authentication required", 401)
            private_key, public_key = generate_key(f"{current['username']}@duckpad")
            self.store.put(
                KEY_KIND,
                user["id"],
                {
                    "id": uid("key_"),
                    "private_key": private_key,
                    "public_key": public_key,
                    "fingerprint": fingerprint(public_key),
                    "created": now(),
                },
            )
        return self.public_key(user["id"])

    def delete_key(self, user_id):
        self.store.delete(KEY_KIND, user_id)

    def private_key(self, user_id):
        record = self.store.get(KEY_KIND, user_id)
        return record["private_key"] if record else None

    # Trusted hosts

    def hosts(self):
        return self.store.get("settings", HOSTS_SETTING, {"host_keys": [], "prefixes": []})

    def public_hosts(self):
        settings = self.hosts()
        return {
            "known_hosts": self.known_hosts(),
            "host_keys": [
                {
                    "hosts": entry["hosts"],
                    "type": entry["type"],
                    "fingerprint": fingerprint(f"{entry['type']} {entry['key']}"),
                }
                for entry in settings["host_keys"]
            ],
            "prefixes": settings["prefixes"],
        }

    def save_hosts(self, known_hosts, prefixes):
        if not isinstance(prefixes, list) or len(prefixes) > MAX_PREFIXES:
            raise Problem(f"Allow at most {MAX_PREFIXES} URL prefixes")
        settings = {
            "host_keys": parse_known_hosts(known_hosts),
            "prefixes": list(dict.fromkeys(validate_prefix(p) for p in prefixes)),
        }
        self.store.put("settings", HOSTS_SETTING, settings)
        return self.public_hosts()

    def known_hosts(self):
        return "".join(
            f"{','.join(entry['hosts'])} {entry['type']} {entry['key']}\n"
            for entry in self.hosts()["host_keys"]
        )

    def check_origin(self, url, status=422):
        """Refuse origins outside trusted SSH hosts and allowed URL prefixes."""
        settings = self.hosts()
        scheme, host, port, path = endpoint(url)
        # Relative segments could leave an allowed prefix once the server normalizes the path.
        if any(segment in (".", "..") for segment in path.split("/")):
            raise Problem("Repository URLs cannot contain . or .. path segments", status)
        prefixes = settings["prefixes"]
        allowed = any(url.startswith(prefix) for prefix in prefixes)
        if scheme == "ssh":
            trusted = host_token(host, port) in {h for e in settings["host_keys"] for h in e["hosts"]}
            allowed = trusted and (allowed or not prefixes)
        if not allowed:
            raise Problem(ORIGIN_REFUSED, status)

    # Consent

    @staticmethod
    def consent_key(project, user_id):
        return f"{project}/{user_id}"

    def consented(self, user_id, project, url):
        record = self.store.get(CONSENT_KIND, self.consent_key(project, user_id))
        return bool(record and record["url"] == url)

    def consent(self, user_id, project, url):
        self.store.put(
            CONSENT_KIND,
            self.consent_key(project, user_id),
            {"user": user_id, "project": project, "url": url, "confirmed": now()},
        )

    def forget_project(self, project):
        """Every origin change requires new consent, even when a previous URL comes back."""
        with self.store.lock:
            for key, record in self.store.items(CONSENT_KIND):
                if record["project"] == project:
                    self.store.delete(CONSENT_KIND, key)

    def credentials(self, user, project, url):
        """Return the private key for an SSH origin, or None for HTTPS, after every check."""
        self.check_origin(url, 409)
        if transport(url) != "ssh":
            return None
        key = self.private_key(user["id"]) if user else None
        if not key:
            raise Problem(
                "Generate your SSH key in User settings and add its public key to your account on the Git "
                "host before synchronizing over SSH.",
                409,
                {"ssh_key_required": True},
            )
        if not self.consented(user["id"], project, url):
            raise Problem(
                "Confirm that Duckpad may use your SSH key for this origin.",
                409,
                {"consent_required": {"url": url}},
            )
        return key
