"""One level of an S3-compatible bucket, listed through the ListObjectsV2 API.

DuckDB's `glob` returns files only and walks every key below its prefix, so it cannot show the
folders of one level of a large bucket; loading `httpfs` in the server process could also stop it.
The listing signs its own requests (AWS Signature Version 4) with the settings that the connector
gives DuckDB's S3 secret, so it reaches the same endpoint, bucket and credentials as a run.
"""

import hashlib
import hmac
import re
import xml.etree.ElementTree as ElementTree
from datetime import UTC, datetime
from urllib.parse import quote, unquote_plus

import httpx2

from .templates import URI
from .types import Record
from .util import Problem

TIMEOUT = 15
# A page of 1,000 keys is about 300 kB; a larger answer is not a listing.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
SCHEMES = ("s3", "s3a", "s3n")
# DuckDB's defaults for the options that an S3 secret leaves out.
DEFAULTS = {
    "key_id": "",
    "secret": "",
    "session_token": "",
    "region": "us-east-1",
    "endpoint": "s3.amazonaws.com",
    "use_ssl": True,
    "url_style": "vhost",
}
SECRET = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMPORARY|PERSISTENT)\s+)?SECRET\b[^(]*\((?P<options>[^)]*)\)",
    re.IGNORECASE,
)
OPTION = re.compile(
    r"\s*(?P<name>[A-Za-z_]+)\s+(?:\{\{\s*(?P<parameter>\w+)\s*\}\}|'(?P<text>(?:[^']|'')*)'|(?P<word>[\w.:-]+))\s*"
)


def client_settings(definition: Record, values: Record) -> Record | None:
    """The S3 settings a connection's setup gives DuckDB, or None when they cannot sign a listing.

    They are read from the connector's `CREATE SECRET (TYPE S3, ...)`: each option is a parameter of
    the connection or a literal, so a customized or custom S3 connector is listed like the built-in one.
    A credential chain or another secret type has no keys Duckpad can sign with.
    """
    for match in SECRET.finditer(definition.get("init_sql") or ""):
        options = secret_options(match["options"], values)
        if options is None or str(options.get("type", "")).lower() != "s3":
            continue
        if str(options.get("provider", "config")).lower() != "config":
            return None
        settings = {**DEFAULTS, **{name: options[name] for name in DEFAULTS if name in options}}
        settings["use_ssl"] = str(settings["use_ssl"]).lower() not in ("false", "0")
        return settings
    return None


def secret_options(options: str, values: Record) -> Record | None:
    found: Record = {}
    # Commas inside quoted literals do not separate options.
    for part in re.findall(r"(?:'(?:[^']|'')*'|[^,'])+", options):
        option = OPTION.fullmatch(part)
        if option is None:
            return None
        if option["parameter"]:
            value = values.get(option["parameter"])
        elif option["text"] is not None:
            value = option["text"].replace("''", "'")
        else:
            value = option["word"]
        found[option["name"].lower()] = value
    return found


def bucket_prefix(root: str) -> tuple[str, str]:
    """The bucket of an `s3://bucket/prefix` root and its key prefix, ending with `/` when set."""
    scheme = root.split("://", 1)[0].lower() if URI.match(root) else ""
    if scheme not in SCHEMES:
        raise Problem("Duckpad cannot list this type of storage yet: enter the path of the file", 422)
    bucket, _, prefix = root.split("://", 1)[1].partition("/")
    if not bucket:
        raise Problem("The connection root names no bucket: use s3://bucket/prefix", 422)
    prefix = prefix.strip("/")
    return bucket, f"{prefix}/" if prefix else ""


def list_level(settings: Record, root: str, path: str, prefix: str, limit: int) -> Record:
    """Folders, then files, of one folder below an S3 root: its first `limit` keys in name order."""
    bucket, base = bucket_prefix(root)
    folder = f"{base}{path}/" if path else base
    query = {
        "list-type": "2",
        "delimiter": "/",
        "encoding-type": "url",
        "max-keys": str(limit),
        "prefix": folder + prefix,
    }
    answer = request(settings, bucket, query)
    entries: list[tuple[bool, str, Record]] = []
    # Any key below the folder proves it exists, even a hidden one or the console's `folder/` marker.
    found = False
    for item in answer.iter("CommonPrefixes"):
        name = decoded(text(item, "Prefix"))[len(folder) :].rstrip("/")
        found = True
        if name and not name.startswith("."):
            entries.append((False, name, {"name": name, "kind": "folder", "size": None, "modified": None}))
    for item in answer.iter("Contents"):
        name = decoded(text(item, "Key"))[len(folder) :]
        found = True
        if not name or "/" in name or name.startswith("."):
            continue
        size = text(item, "Size")
        entries.append(
            (
                True,
                name,
                {
                    "name": name,
                    "kind": "file",
                    "size": int(size) if size.isdigit() else None,
                    "modified": timestamp(text(item, "LastModified")),
                },
            )
        )
    truncated = text(answer, "IsTruncated").lower() == "true"
    if path and not prefix and not found and not truncated:
        raise Problem("This folder does not exist in the bucket", 404)
    entries.sort(key=lambda item: (item[0], item[1].casefold(), item[1]))
    return {"entries": [entry for *_, entry in entries], "truncated": truncated}


def request(settings: Record, bucket: str, query: dict[str, str]) -> ElementTree.Element:
    endpoint = str(settings["endpoint"] or DEFAULTS["endpoint"]).strip().rstrip("/")
    scheme = "https" if settings["use_ssl"] else "http"
    if URI.match(endpoint):
        scheme, endpoint = endpoint.split("://", 1)
    path_style = str(settings["url_style"]).lower() == "path"
    host = endpoint if path_style else f"{bucket}.{endpoint}"
    path = f"/{bucket}" if path_style else "/"
    canonical_query = "&".join(f"{encode(k)}={encode(v)}" for k, v in sorted(query.items()))
    headers = signed_headers(settings, host, path, canonical_query, datetime.now(UTC))
    body = bytearray()
    try:
        with (
            httpx2.Client(timeout=TIMEOUT, follow_redirects=False) as client,
            client.stream("GET", f"{scheme}://{host}{path}?{canonical_query}", headers=headers) as response,
        ):
            for chunk in response.iter_bytes():
                body += chunk
                if len(body) > MAX_RESPONSE_BYTES:
                    raise Problem("The storage endpoint sent an answer too large for a listing", 422)
            status = response.status_code
    except httpx2.HTTPError as error:
        raise Problem(f"Duckpad cannot reach the storage endpoint {endpoint}: {error}", 422) from None
    try:
        document = strip_namespaces(ElementTree.fromstring(bytes(body))) if body else None
    except ElementTree.ParseError:
        document = None
    if status == 200 and document is not None and document.tag == "ListBucketResult":
        return document
    raise refusal(status, document, bucket)


def refusal(status: int, document: ElementTree.Element | None, bucket: str) -> Problem:
    code = text(document, "Code") if document is not None else ""
    message = text(document, "Message") if document is not None else ""
    if code == "NoSuchBucket":
        return Problem(f"The bucket {bucket} does not exist on this endpoint", 404)
    if code == "AccessDenied":
        return Problem(
            "The storage refused to list this folder (AccessDenied): the connection's credentials need "
            "the s3:ListBucket permission. Enter the path of the file instead.",
            422,
        )
    if code in ("InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken"):
        return Problem(f"The storage refused the connection's credentials ({code})", 422)
    if code in ("PermanentRedirect", "AuthorizationHeaderMalformed") or status in (301, 307):
        return Problem(
            f"The bucket {bucket} answers on another region or endpoint: check the connection's "
            f"region and endpoint ({code or status})",
            422,
        )
    detail = f"{code}: {message}" if code else f"HTTP {status}"
    return Problem(f"The storage endpoint refused the listing ({detail})", 422)


def signed_headers(settings: Record, host: str, path: str, query: str, now: datetime) -> dict[str, str]:
    """Headers of an AWS Signature Version 4 GET without a body; anonymous without a key."""
    stamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(b"").hexdigest()
    headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": stamp}
    if settings["session_token"]:
        headers["x-amz-security-token"] = str(settings["session_token"])
    if not settings["key_id"]:
        return headers
    names = sorted(headers)
    canonical = "\n".join(
        [
            "GET",
            quote(path, safe="/-_.~"),
            query,
            "".join(f"{name}:{headers[name].strip()}\n" for name in names),
            ";".join(names),
            payload,
        ]
    )
    region = str(settings["region"] or DEFAULTS["region"])
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = f"AWS4{settings['secret']}".encode()
    for part in (day, region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={settings['key_id']}/{scope}, "
        f"SignedHeaders={';'.join(names)}, Signature={signature}"
    )
    return headers


def encode(value: str) -> str:
    """URI encoding of SigV4: every byte except unreserved characters."""
    return quote(value, safe="-_.~")


def decoded(key: str) -> str:
    # Keys are URL-encoded on request: XML cannot carry every character a key may hold.
    return unquote_plus(key)


def strip_namespaces(element: ElementTree.Element) -> ElementTree.Element:
    for item in element.iter():
        item.tag = item.tag.rpartition("}")[2]
    return element


def text(element: ElementTree.Element | None, tag: str) -> str:
    found = element.find(tag) if element is not None else None
    return (found.text or "") if found is not None else ""


def timestamp(value: str) -> str | None:
    try:
        return datetime.fromisoformat(value).astimezone(UTC).isoformat(timespec="seconds")
    except ValueError:
        return None
